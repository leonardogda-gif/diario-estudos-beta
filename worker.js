const GOOGLE_CLIENT_ID =
  "629410527657-f5b9r4o0jvcvf0517oracmhpvhsj19pn.apps.googleusercontent.com";

const ALLOWED_ORIGINS = [
  "https://leonardogda-gif.github.io",
  "https://app.meudiariodeestudos.com.br",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    const corsOrigin = ALLOWED_ORIGINS.includes(origin)
      ? origin
      : "https://leonardogda-gif.github.io";

    const corsHeaders = {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          ...corsHeaders
        }
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    function newId(prefix) {
      return `${prefix}_${crypto.randomUUID()}`;
    }

    function normalizeEmail(email) {
      return String(email || "").trim().toLowerCase();
    }

    function asaasBaseUrl() {
      return String(env.ASAAS_API_BASE || "https://api-sandbox.asaas.com/v3").replace(/\/$/, "");
    }

    async function asaasFetch(path, options = {}) {
      if (!env.ASAAS_API_KEY) throw new Error("ASAAS_NOT_CONFIGURED");
      const response = await fetch(asaasBaseUrl() + path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "MeuDiarioDeEstudos/11.1 (Cloudflare-Workers)",
          access_token: env.ASAAS_API_KEY,
          ...(options.headers || {})
        }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data?.errors?.map(x => x.description).filter(Boolean).join("; ") || data?.message || `Asaas recusou a solicitação (${response.status})`;
        throw Object.assign(new Error(message), { providerStatus: response.status });
      }
      return data;
    }

    function asaasPlan(code) {
      if (code === "monthly") return {code, name:"Plano mensal", value:39.90, cycle:"MONTHLY"};
      if (code === "yearly") return {code, name:"Plano anual", value:359.10, cycle:"YEARLY"};
      return null;
    }

    function paidPeriodEnd(dueDate, planCode) {
      const match = String(dueDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return null;
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      const months = planCode === "yearly" ? 12 : 1;
      const totalMonth = month - 1 + months;
      const targetYear = year + Math.floor(totalMonth / 12), targetMonth = totalMonth % 12;
      const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
      return `${targetYear}-${String(targetMonth + 1).padStart(2,"0")}-${String(Math.min(day,lastDay)).padStart(2,"0")}`;
    }

    async function asaasPaidThrough(providerSubscriptionId, planCode) {
      if (!providerSubscriptionId) return null;
      const listed = await asaasFetch(`/payments?subscription=${encodeURIComponent(providerSubscriptionId)}&limit=100`);
      const paidStatuses = new Set(["CONFIRMED","RECEIVED","RECEIVED_IN_CASH"]);
      const paid = (Array.isArray(listed?.data) ? listed.data : [])
        .filter(item => paidStatuses.has(String(item?.status || "")) && /^\d{4}-\d{2}-\d{2}$/.test(String(item?.dueDate || "")))
        .sort((a,b) => String(b.dueDate).localeCompare(String(a.dueDate)))[0];
      return paid ? paidPeriodEnd(paid.dueDate,planCode) : null;
    }

    async function reconcileAsaasSubscription(subscription) {
      if (!subscription || subscription.provider_subscription_id || !subscription.provider_checkout_id) return subscription;

      // Webhooks may arrive out of order. First reuse the payment payload that
      // is already stored in D1 and linked to this exact checkout session.
      const historicalPayment = await env.DB.prepare(`
        SELECT
          json_extract(payload_json,'$.payment.customer') AS customer_id,
          json_extract(payload_json,'$.payment.subscription') AS subscription_id
        FROM asaas_webhook_events
        WHERE event_type IN ('PAYMENT_CREATED','PAYMENT_CONFIRMED','PAYMENT_RECEIVED')
          AND json_extract(payload_json,'$.payment.checkoutSession')=?
          AND json_extract(payload_json,'$.payment.subscription') IS NOT NULL
        ORDER BY received_at DESC
        LIMIT 1
      `).bind(subscription.provider_checkout_id).first().catch(() => null);

      let providerSubscriptionId = String(historicalPayment?.subscription_id || "").trim();
      let providerCustomerId = String(historicalPayment?.customer_id || subscription.provider_customer_id || "").trim() || null;
      let remote = {};

      if (!providerSubscriptionId) {
        const payments = await asaasFetch(`/payments?checkoutSession=${encodeURIComponent(subscription.provider_checkout_id)}&limit=10`);
        const paymentItems = Array.isArray(payments?.data) ? payments.data : [];
        const payment = paymentItems.find(item => item?.subscription) || paymentItems.find(item => item?.customer) || null;
        providerSubscriptionId = String(payment?.subscription || "").trim();
        providerCustomerId = String(payment?.customer || providerCustomerId || "").trim() || null;
      }

      if (providerSubscriptionId) {
        remote = await asaasFetch(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}`).catch(() => ({}));
        providerCustomerId = String(remote?.customer || providerCustomerId || "").trim() || null;
      } else if (providerCustomerId) {
        // Some Checkout payment payloads omit `subscription`. Recover it from
        // the customer, preferring a record that matches this app's plan.
        const listed = await asaasFetch(`/subscriptions?customer=${encodeURIComponent(providerCustomerId)}&limit=100`);
        const candidates = Array.isArray(listed?.data) ? listed.data : [];
        const plan = asaasPlan(subscription.plan_code);
        remote = candidates.find(item =>
          item?.status === "ACTIVE" &&
          (!plan || (Number(item?.value) === Number(plan.value) && item?.cycle === plan.cycle))
        ) || candidates.find(item => item?.status === "ACTIVE") || candidates[0] || {};
        providerSubscriptionId = String(remote?.id || "").trim();
      }

      if (!providerSubscriptionId) return subscription;
      // `subscription.nextDueDate` is the next date the scheduler will generate,
      // not the end of paid access. Derive entitlement only from paid charges.
      const nextDueDate = await asaasPaidThrough(providerSubscriptionId,subscription.plan_code).catch(() => null);

      await env.DB.prepare(`
        UPDATE asaas_family_subscriptions
        SET provider_subscription_id=?,
            provider_customer_id=COALESCE(?,provider_customer_id),
            next_due_date=COALESCE(?,next_due_date),
            updated_at=CURRENT_TIMESTAMP
        WHERE family_id=?
      `).bind(providerSubscriptionId,providerCustomerId,nextDueDate,subscription.family_id).run();

      return {
        ...subscription,
        provider_subscription_id: providerSubscriptionId,
        provider_customer_id: providerCustomerId || subscription.provider_customer_id || null,
        next_due_date: nextDueDate || subscription.next_due_date || null
      };
    }

    async function googleUserFromRequest() {
      const auth = request.headers.get("Authorization") || "";

      if (!auth.startsWith("Bearer ")) {
        throw new Error("AUTH_MISSING");
      }

      const accessToken = auth.substring(7).trim();

      if (!accessToken) {
        throw new Error("AUTH_MISSING");
      }

      const tokenResponse = await fetch(
        "https://oauth2.googleapis.com/tokeninfo?access_token=" +
        encodeURIComponent(accessToken)
      );

      if (!tokenResponse.ok) {
        throw new Error("AUTH_INVALID");
      }

      const tokenInfo = await tokenResponse.json();

      const audience =
        tokenInfo.aud ||
        tokenInfo.audience ||
        tokenInfo.issued_to ||
        "";

      if (audience !== GOOGLE_CLIENT_ID) {
        throw new Error("AUTH_WRONG_AUDIENCE");
      }

      const profileResponse = await fetch(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      if (!profileResponse.ok) {
        throw new Error("AUTH_PROFILE_FAILED");
      }

      const profile = await profileResponse.json();

      if (!profile.sub || !profile.email) {
        throw new Error("AUTH_PROFILE_INCOMPLETE");
      }

      return {
        googleSub: profile.sub,
        email: normalizeEmail(profile.email),
        name: profile.name || "",
        picture: profile.picture || ""
      };
    }

    async function requireUser() {
      const google = await googleUserFromRequest();

      let user = await env.DB
        .prepare(`
          SELECT *
          FROM users
          WHERE google_sub = ?
          LIMIT 1
        `)
        .bind(google.googleSub)
        .first();

      if (!user) {
        const userId = newId("usr");

        await env.DB
          .prepare(`
            INSERT INTO users
            (
              id,
              google_sub,
              email,
              name,
              picture_url
            )
            VALUES (?, ?, ?, ?, ?)
          `)
          .bind(
            userId,
            google.googleSub,
            google.email,
            google.name,
            google.picture
          )
          .run();

        user = await env.DB
          .prepare(`
            SELECT *
            FROM users
            WHERE id = ?
          `)
          .bind(userId)
          .first();
      } else {
        await env.DB
          .prepare(`
            UPDATE users
            SET
              email = ?,
              name = ?,
              picture_url = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            google.email,
            google.name,
            google.picture,
            user.id
          )
          .run();

        user.email = google.email;
        user.name = google.name;
        user.picture_url = google.picture;
      }

      return user;
    }

    async function getMembership(userId, familyId) {
      return await env.DB
        .prepare(`
          SELECT *
          FROM family_members
          WHERE user_id = ?
            AND family_id = ?
          LIMIT 1
        `)
        .bind(userId, familyId)
        .first();
    }

    async function requireFamilyMember(userId, familyId) {
      const member = await getMembership(userId, familyId);

      if (!member) {
        throw new Error("FAMILY_FORBIDDEN");
      }

      return member;
    }

    async function requireFamilyAdmin(userId, familyId) {
      const member = await requireFamilyMember(userId, familyId);

      if (member.role !== "admin") {
        throw new Error("ADMIN_REQUIRED");
      }

      return member;
    }

    // Administrador GLOBAL do catálogo de materiais (não confundir com
    // administrador de família). Configure no Cloudflare uma variável de texto
    // GLOBAL_ADMIN_EMAILS com um ou mais e-mails separados por vírgula ou ponto e vírgula.
    // Ex.: admin1@exemplo.com,admin2@exemplo.com
function globalAdminEmails() {
  return [
    "leonardo.gda@gmail.com"
  ].map(normalizeEmail);
}

    function isGlobalAdmin(user) {
      const email = normalizeEmail(user?.email);
      return !!email && globalAdminEmails().includes(email);
    }

    function requireGlobalAdmin(user) {
      if (!isGlobalAdmin(user)) {
        throw new Error("GLOBAL_ADMIN_REQUIRED");
      }
    }

    function aiUsageNumber(usage, ...keys) {
      for (const key of keys) {
        const value = Number(usage?.[key]);
        if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
      }
      return 0;
    }

    function aiModelRates(model) {
      const safe = String(model || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      const defaults = model === "gemini-embedding-2" ? {input:0.20,output:0} : model === "gemini-3.5-flash-lite" ? {input:0.30,output:2.50} : {input:0,output:0};
      const input = Number(env[`AI_${safe}_INPUT_USD_PER_MILLION`] ?? env.AI_INPUT_USD_PER_MILLION ?? defaults.input);
      const output = Number(env[`AI_${safe}_OUTPUT_USD_PER_MILLION`] ?? env.AI_OUTPUT_USD_PER_MILLION ?? defaults.output);
      return {
        input: Number.isFinite(input) && input >= 0 ? input : 0,
        output: Number.isFinite(output) && output >= 0 ? output : 0
      };
    }

    async function recordAiUsage({userId="", familyId="", childId="", requestId="", feature="", operation="", model="", usage={}, tokenCountSource="provider", status="success", providerStatus=0}) {
      if (!userId || !familyId || !feature || !model) return;
      const promptTokens = aiUsageNumber(usage, "promptTokenCount", "prompt_tokens");
      const outputTokens = aiUsageNumber(usage, "candidatesTokenCount", "output_tokens");
      const thoughtsTokens = aiUsageNumber(usage, "thoughtsTokenCount", "thoughts_tokens");
      const reportedTotal = aiUsageNumber(usage, "totalTokenCount", "total_tokens");
      const totalTokens = reportedTotal || promptTokens + outputTokens + thoughtsTokens;
      const rates = aiModelRates(model);
      const estimatedInputCostUsdMicros = Math.max(0, Math.round(promptTokens * rates.input));
      const estimatedOutputCostUsdMicros = Math.max(0, Math.round((outputTokens + thoughtsTokens) * rates.output));
      const estimatedCostUsdMicros = estimatedInputCostUsdMicros + estimatedOutputCostUsdMicros;
      try {
        await env.DB.prepare(`
          INSERT INTO ai_usage_events
          (id,request_id,family_id,user_id,child_id,feature,operation,model,token_count_source,status,provider_status,prompt_tokens,output_tokens,thoughts_tokens,total_tokens,input_rate_usd_per_million,output_rate_usd_per_million,estimated_input_cost_usd_micros,estimated_output_cost_usd_micros,estimated_cost_usd_micros)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(newId("aiu"),requestId||newId("air"),familyId,userId,childId||null,feature,operation||feature,model,tokenCountSource,status,providerStatus||null,promptTokens,outputTokens,thoughtsTokens,totalTokens,rates.input,rates.output,estimatedInputCostUsdMicros,estimatedOutputCostUsdMicros,estimatedCostUsdMicros).run();
      } catch (error) {
        console.warn("AI usage could not be recorded", error?.message || error);
      }
    }

    // =========================================================
    // ROTAS PÚBLICAS
    // =========================================================

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        ok: true,
        service: "Diário de Estudos API",
        version: "0.45-beta",
        status: "online"
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        worker: true,
        database: !!env.DB
      });
    }

    if (url.pathname === "/db-test" && request.method === "GET") {
      try {
        const result = await env.DB
          .prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            ORDER BY name
          `)
          .all();

        return json({
          ok: true,
          database: "conectado",
          tables: result.results
        });
      } catch (error) {
        return json(
          {
            ok: false,
            database: "erro",
            error: error.message
          },
          500
        );
      }
    }

    if (url.pathname === "/payments/asaas/webhook" && request.method === "POST") {
      if (!env.ASAAS_WEBHOOK_TOKEN || request.headers.get("asaas-access-token") !== env.ASAAS_WEBHOOK_TOKEN) {
        return json({ok:false,error:"Webhook não autorizado"},401);
      }
      const body = await request.json().catch(() => ({}));
      const eventId = String(body.id || "").trim(), eventType = String(body.event || "").trim();
      if (!eventId || !eventType) return json({ok:false,error:"Evento inválido"},400);
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO asaas_webhook_events (event_id,event_type,payload_json) VALUES (?,?,?)`).bind(eventId,eventType,JSON.stringify(body)).run();
      if (!inserted.meta?.changes) return json({ok:true,duplicate:true});
      try {
        const checkout = body.checkout || {}, subscription = body.subscription || {}, payment = body.payment || {};
        if (checkout.id) {
          const status = eventType === "CHECKOUT_PAID" ? "paid" : eventType === "CHECKOUT_CANCELED" ? "canceled" : eventType === "CHECKOUT_EXPIRED" ? "expired" : "pending";
          await env.DB.prepare(`UPDATE asaas_checkout_sessions SET status=?,provider_customer_id=COALESCE(?,provider_customer_id),updated_at=CURRENT_TIMESTAMP WHERE provider_checkout_id=?`).bind(status,checkout.customer || null,checkout.id).run();
          if (eventType === "CHECKOUT_PAID") {
            const session = await env.DB.prepare(`SELECT * FROM asaas_checkout_sessions WHERE provider_checkout_id=? LIMIT 1`).bind(checkout.id).first();
            if (session) await env.DB.prepare(`INSERT INTO asaas_family_subscriptions (family_id,plan_code,status,provider_checkout_id,provider_customer_id,started_at,updated_at) VALUES (?,?,'active',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(family_id) DO UPDATE SET plan_code=excluded.plan_code,status='active',provider_checkout_id=excluded.provider_checkout_id,provider_customer_id=excluded.provider_customer_id,cancel_at_period_end=0,canceled_at=NULL,started_at=COALESCE(asaas_family_subscriptions.started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP`).bind(session.family_id,session.plan_code,checkout.id,checkout.customer || null).run();
          }
        }
        if (subscription.id) {
          const customerId = String(subscription.customer || "").trim();
          const lifecycleEnded = ["SUBSCRIPTION_DELETED","SUBSCRIPTION_INACTIVATED"].includes(eventType);
          const subscriptionStatus = lifecycleEnded ? "canceled" : "active";
          let linked = {meta:{changes:0}};
          if (customerId) {
            linked = await env.DB.prepare(`UPDATE asaas_family_subscriptions SET provider_subscription_id=?,provider_customer_id=?,status=CASE WHEN ?=1 AND cancel_at_period_end=1 AND datetime(next_due_date)>datetime('now') THEN 'active' ELSE ? END,next_due_date=COALESCE(?,next_due_date),updated_at=CURRENT_TIMESTAMP WHERE provider_customer_id=?`).bind(subscription.id,customerId,lifecycleEnded ? 1 : 0,subscriptionStatus,subscription.nextDueDate || null,customerId).run();
          }
          if (!linked.meta?.changes && customerId) {
            const session = await env.DB.prepare(`SELECT family_id,plan_code,provider_checkout_id FROM asaas_checkout_sessions WHERE provider_customer_id=? AND status='paid' ORDER BY created_at DESC LIMIT 1`).bind(customerId).first();
            if (session) {
              await env.DB.prepare(`INSERT INTO asaas_family_subscriptions (family_id,plan_code,status,provider_checkout_id,provider_customer_id,provider_subscription_id,next_due_date,started_at,updated_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(family_id) DO UPDATE SET plan_code=excluded.plan_code,status=excluded.status,provider_checkout_id=excluded.provider_checkout_id,provider_customer_id=excluded.provider_customer_id,provider_subscription_id=excluded.provider_subscription_id,next_due_date=COALESCE(excluded.next_due_date,asaas_family_subscriptions.next_due_date),updated_at=CURRENT_TIMESTAMP`).bind(session.family_id,session.plan_code,subscriptionStatus,session.provider_checkout_id,customerId,subscription.id,subscription.nextDueDate || null).run();
            }
          }
        }
        if (payment.subscription) {
          const paymentStatus = ["PAYMENT_CONFIRMED","PAYMENT_RECEIVED"].includes(eventType) ? "active" : ["PAYMENT_OVERDUE","PAYMENT_DUNNING_REQUESTED"].includes(eventType) ? "past_due" : ["PAYMENT_REFUNDED","PAYMENT_CHARGEBACK_REQUESTED","PAYMENT_DELETED"].includes(eventType) ? "canceled" : null;
          if (paymentStatus) {
            const localSubscription = await env.DB.prepare(`SELECT plan_code FROM asaas_family_subscriptions WHERE provider_subscription_id=? LIMIT 1`).bind(payment.subscription).first();
            const paidUntil = ["PAYMENT_CONFIRMED","PAYMENT_RECEIVED"].includes(eventType) ? paidPeriodEnd(payment.dueDate,localSubscription?.plan_code) : null;
            await env.DB.prepare(`UPDATE asaas_family_subscriptions SET status=?,last_payment_id=?,next_due_date=COALESCE(?,next_due_date),updated_at=CURRENT_TIMESTAMP WHERE provider_subscription_id=?`).bind(paymentStatus,payment.id || null,paidUntil,payment.subscription).run();
          }
        }
        await env.DB.prepare(`UPDATE asaas_webhook_events SET processed_at=CURRENT_TIMESTAMP,status='processed' WHERE event_id=?`).bind(eventId).run();
        return json({ok:true});
      } catch (error) {
        await env.DB.prepare(`UPDATE asaas_webhook_events SET processed_at=CURRENT_TIMESTAMP,status='error',error_detail=? WHERE event_id=?`).bind(String(error.message || error),eventId).run();
        return json({ok:false,error:"Falha ao processar evento"},500);
      }
    }

    try {
      const user = await requireUser();

      if (url.pathname === "/payments/asaas/status" && request.method === "GET") {
        const familyId = String(url.searchParams.get("family_id") || "").trim();
        await requireFamilyMember(user.id,familyId);
        const grant = await env.DB.prepare(`SELECT grant_type,reason,ends_at FROM family_access_grants WHERE family_id=? AND active=1 AND (ends_at IS NULL OR datetime(ends_at)>datetime('now')) ORDER BY created_at DESC LIMIT 1`).bind(familyId).first();
        // Removing the recurrence cancels it at Asaas immediately, but the
        // family keeps entitlement through the already-paid period.
        await env.DB.prepare(`UPDATE asaas_family_subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE family_id=? AND cancel_at_period_end=1 AND next_due_date IS NOT NULL AND datetime(next_due_date)>datetime('now')`).bind(familyId).run();
        await env.DB.prepare(`UPDATE asaas_family_subscriptions SET status='canceled',updated_at=CURRENT_TIMESTAMP WHERE family_id=? AND cancel_at_period_end=1 AND next_due_date IS NOT NULL AND datetime(next_due_date)<=datetime('now')`).bind(familyId).run();
        let subscription = await env.DB.prepare(`SELECT family_id,plan_code,status,provider_checkout_id,provider_customer_id,provider_subscription_id,next_due_date,cancel_at_period_end,created_at,updated_at FROM asaas_family_subscriptions WHERE family_id=? LIMIT 1`).bind(familyId).first();
        if (subscription && !subscription.provider_subscription_id) {
          subscription = await reconcileAsaasSubscription(subscription).catch(() => subscription);
        }
        if (subscription?.provider_subscription_id) {
          const paidUntil = await asaasPaidThrough(subscription.provider_subscription_id,subscription.plan_code).catch(() => null);
          if (paidUntil && paidUntil !== subscription.next_due_date) {
            await env.DB.prepare(`UPDATE asaas_family_subscriptions SET next_due_date=?,updated_at=CURRENT_TIMESTAMP WHERE family_id=?`).bind(paidUntil,familyId).run();
            subscription = {...subscription,next_due_date:paidUntil};
          }
        }
        const checkout = await env.DB.prepare(`SELECT status,plan_code,provider_checkout_id,created_at FROM asaas_checkout_sessions WHERE family_id=? ORDER BY created_at DESC LIMIT 1`).bind(familyId).first();
        const checkoutData = checkout ? {...checkout,checkout_url:(asaasBaseUrl().includes("sandbox") ? `https://sandbox.asaas.com/checkoutSession/show/${encodeURIComponent(checkout.provider_checkout_id)}` : `https://asaas.com/checkoutSession/show/${encodeURIComponent(checkout.provider_checkout_id)}`)} : null;
        return json({ok:true,environment:asaasBaseUrl().includes("sandbox")?"sandbox":"production",grant:grant || null,subscription:subscription || null,checkout:checkoutData});
      }

      if (url.pathname === "/payments/asaas/checkout" && request.method === "POST") {
        const body = await request.json().catch(() => ({})), familyId = String(body.family_id || "").trim(), plan = asaasPlan(String(body.plan || ""));
        if (!familyId || !plan) return json({ok:false,error:"Família e plano válido são obrigatórios"},400);
        await requireFamilyAdmin(user.id,familyId);
        const grant = await env.DB.prepare(`SELECT id FROM family_access_grants WHERE family_id=? AND active=1 AND (ends_at IS NULL OR datetime(ends_at)>datetime('now')) LIMIT 1`).bind(familyId).first();
        if (grant) return json({ok:false,error:"Esta família já possui acesso gratuito autorizado"},409);
        const active = await env.DB.prepare(`SELECT status FROM asaas_family_subscriptions WHERE family_id=? AND (status IN ('active','past_due') OR (cancel_at_period_end=1 AND next_due_date IS NOT NULL AND datetime(next_due_date)>datetime('now'))) LIMIT 1`).bind(familyId).first();
        if (active) return json({ok:false,error:"Esta família já possui uma assinatura"},409);
        const now = new Date(Date.now()+65*60000).toISOString().slice(0,19).replace("T"," ");
        const callback = {successUrl:"https://app.meudiariodeestudos.com.br/?asaas=success",cancelUrl:"https://app.meudiariodeestudos.com.br/?asaas=cancel",expiredUrl:"https://app.meudiariodeestudos.com.br/?asaas=expired"};
        const itemName = plan.code === "yearly" ? "Diario de Estudos - Anual" : "Diario de Estudos - Mensal";
        const checkout = await asaasFetch("/checkouts",{method:"POST",body:JSON.stringify({billingTypes:["CREDIT_CARD"],chargeTypes:["RECURRENT"],minutesToExpire:60,externalReference:familyId,callback,items:[{name:itemName,description:"Assinatura familiar do Diario de Estudos",quantity:1,value:plan.value}],subscription:{cycle:plan.cycle,nextDueDate:now}})});
        const checkoutId = String(checkout.id || ""); if (!checkoutId) throw new Error("O Asaas não retornou o ID do checkout");
        const checkoutUrl = String(checkout.link || (asaasBaseUrl().includes("sandbox") ? `https://sandbox.asaas.com/checkoutSession/show/${encodeURIComponent(checkoutId)}` : `https://asaas.com/checkoutSession/show/${encodeURIComponent(checkoutId)}`));
        await env.DB.prepare(`INSERT INTO asaas_checkout_sessions (id,family_id,user_id,plan_code,amount,cycle,provider_checkout_id,status) VALUES (?,?,?,?,?,?,?,'pending')`).bind(newId("ach"),familyId,user.id,plan.code,plan.value,plan.cycle,checkoutId).run();
        return json({ok:true,checkout_id:checkoutId,checkout_url:checkoutUrl,environment:asaasBaseUrl().includes("sandbox")?"sandbox":"production"});
      }

      if (url.pathname === "/payments/asaas/cancel" && request.method === "POST") {
        const body = await request.json().catch(() => ({})), familyId = String(body.family_id || "").trim();
        await requireFamilyAdmin(user.id,familyId);
        let subscription = await env.DB.prepare(`SELECT family_id,plan_code,provider_checkout_id,provider_customer_id,provider_subscription_id,next_due_date,CASE WHEN next_due_date IS NOT NULL AND datetime(next_due_date)>datetime('now') THEN 1 ELSE 0 END AS access_valid FROM asaas_family_subscriptions WHERE family_id=? AND status IN ('active','past_due') LIMIT 1`).bind(familyId).first();
        if (subscription && !subscription.provider_subscription_id) {
          await reconcileAsaasSubscription(subscription);
          subscription = await env.DB.prepare(`SELECT family_id,plan_code,provider_checkout_id,provider_customer_id,provider_subscription_id,next_due_date,CASE WHEN next_due_date IS NOT NULL AND datetime(next_due_date)>datetime('now') THEN 1 ELSE 0 END AS access_valid FROM asaas_family_subscriptions WHERE family_id=? AND status IN ('active','past_due') LIMIT 1`).bind(familyId).first();
        }
        if (!subscription?.provider_subscription_id) return json({ok:false,error:"A assinatura ainda não foi vinculada pelo webhook. Atualize a situação em alguns instantes."},409);
        const paidUntil = await asaasPaidThrough(subscription.provider_subscription_id,subscription.plan_code).catch(() => null);
        if (paidUntil) {
          subscription.next_due_date = paidUntil;
          subscription.access_valid = new Date(`${paidUntil}T23:59:59Z`).getTime() > Date.now() ? 1 : 0;
          await env.DB.prepare(`UPDATE asaas_family_subscriptions SET next_due_date=?,updated_at=CURRENT_TIMESTAMP WHERE family_id=?`).bind(paidUntil,familyId).run();
        }
        await asaasFetch(`/subscriptions/${encodeURIComponent(subscription.provider_subscription_id)}`,{method:"DELETE"});
        const keepsAccess = Number(subscription.access_valid || 0) === 1;
        await env.DB.prepare(`UPDATE asaas_family_subscriptions SET status=?,cancel_at_period_end=1,canceled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE family_id=?`).bind(keepsAccess ? "active" : "canceled",familyId).run();
        return json({ok:true,access_until:keepsAccess ? subscription.next_due_date : null});
      }

      if (url.pathname === "/admin/access-grants" && request.method === "GET") {
        requireGlobalAdmin(user);
        const families = await env.DB.prepare(`
          SELECT f.id,f.name,
            (SELECT grant_type FROM family_access_grants g WHERE g.family_id=f.id AND g.active=1 AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now')) ORDER BY g.created_at DESC LIMIT 1) AS grant_type,
            (SELECT reason FROM family_access_grants g WHERE g.family_id=f.id AND g.active=1 AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now')) ORDER BY g.created_at DESC LIMIT 1) AS grant_reason
          FROM families f ORDER BY f.name
        `).all();
        return json({ok:true,families:families.results || []});
      }

      if (url.pathname === "/admin/access-grants" && request.method === "POST") {
        requireGlobalAdmin(user);
        const body = await request.json().catch(() => ({}));
        const familyId = String(body.family_id || "").trim();
        const grantType = String(body.grant_type || "").trim();
        const reason = String(body.reason || "").trim();
        if (!familyId || !["beta_tester","social","partnership","courtesy"].includes(grantType) || !reason) return json({ok:false,error:"Família, tipo e motivo são obrigatórios"},400);
        await env.DB.prepare(`UPDATE family_access_grants SET active=0,updated_at=CURRENT_TIMESTAMP WHERE family_id=? AND active=1`).bind(familyId).run();
        await env.DB.prepare(`INSERT INTO family_access_grants (id,family_id,grant_type,reason,ends_at,created_by_user_id) VALUES (?,?,?,?,?,?)`).bind(newId("grt"),familyId,grantType,reason,body.ends_at || null,user.id).run();
        return json({ok:true});
      }

      if (url.pathname === "/admin/access-grants/revoke" && request.method === "POST") {
        requireGlobalAdmin(user);
        const body = await request.json().catch(() => ({}));
        await env.DB.prepare(`UPDATE family_access_grants SET active=0,updated_at=CURRENT_TIMESTAMP WHERE family_id=? AND active=1`).bind(String(body.family_id || "")).run();
        return json({ok:true});
      }

      if (url.pathname === "/admin/allowed-signups" && request.method === "GET") {
        requireGlobalAdmin(user);
        const result = await env.DB.prepare(`SELECT email,note,created_by,created_at FROM allowed_signups ORDER BY created_at DESC`).all();
        return json({ok:true,emails:result.results || []});
      }

      if (url.pathname === "/admin/allowed-signups" && request.method === "POST") {
        requireGlobalAdmin(user);
        const body = await request.json().catch(() => ({}));
        const email = normalizeEmail(body.email), note = String(body.note || "").trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ok:false,error:"Informe um e-mail válido"},400);
        await env.DB.prepare(`INSERT INTO allowed_signups(email,note,created_by) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET note=excluded.note`).bind(email,note,user.id).run();
        return json({ok:true,email});
      }

      if (url.pathname === "/admin/allowed-signups/remove" && request.method === "POST") {
        requireGlobalAdmin(user);
        const body = await request.json().catch(() => ({})), email = normalizeEmail(body.email);
        if (!email) return json({ok:false,error:"E-mail é obrigatório"},400);
        await env.DB.prepare(`DELETE FROM allowed_signups WHERE email=?`).bind(email).run();
        return json({ok:true,email});
      }

      // =========================================================
      // ME
      // =========================================================

      if (url.pathname === "/me" && request.method === "GET") {
        const families = await env.DB
          .prepare(`
            SELECT
              f.id,
              f.name,
              fm.role,
              fm.joined_at
            FROM family_members fm
            JOIN families f
              ON f.id = fm.family_id
            WHERE fm.user_id = ?
            ORDER BY f.name
          `)
          .bind(user.id)
          .all();

        const invites = await env.DB
          .prepare(`
            SELECT
              i.id,
              i.family_id,
              f.name AS family_name,
              i.email,
              i.role,
              i.status,
              i.created_at,
              i.expires_at
            FROM invites i
            JOIN families f
              ON f.id = i.family_id
            WHERE LOWER(i.email) = LOWER(?)
              AND i.status = 'pending'
            ORDER BY i.created_at DESC
          `)
          .bind(user.email)
          .all();

        const signupAllowed = (families.results || []).length > 0 || !!(await env.DB
          .prepare(`SELECT 1 FROM allowed_signups WHERE email=? LIMIT 1`)
          .bind(normalizeEmail(user.email))
          .first());

        return json({
          ok: true,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            picture: user.picture_url
          },
          families: families.results,
          pendingInvites: invites.results,
          signup_allowed: signupAllowed
        });
      }

      // =========================================================
      // FAMÍLIAS
      // =========================================================

      if (url.pathname === "/families" && request.method === "GET") {
        const result = await env.DB
          .prepare(`
            SELECT
              f.id,
              f.name,
              f.created_at,
              fm.role
            FROM family_members fm
            JOIN families f
              ON f.id = fm.family_id
            WHERE fm.user_id = ?
            ORDER BY f.name
          `)
          .bind(user.id)
          .all();

        return json({
          ok: true,
          families: result.results
        });
      }

      if (url.pathname === "/families" && request.method === "POST") {
        const body = await request.json();
        const familyName = String(body.name || "").trim();

        if (!familyName) {
          return json(
            {
              ok: false,
              error: "Nome da família é obrigatório"
            },
            400
          );
        }

        const alreadyMember = await env.DB.prepare(`SELECT 1 FROM family_members WHERE user_id=? LIMIT 1`).bind(user.id).first();
        if (!alreadyMember) {
          const allowed = await env.DB.prepare(`SELECT 1 FROM allowed_signups WHERE email=? LIMIT 1`).bind(normalizeEmail(user.email)).first();
          if (!allowed) return json({ok:false,error:"SIGNUP_NOT_ALLOWED"},403);
        }

        const familyId = newId("fam");

        await env.DB.batch([
          env.DB
            .prepare(`
              INSERT INTO families
              (
                id,
                name,
                created_by
              )
              VALUES (?, ?, ?)
            `)
            .bind(
              familyId,
              familyName,
              user.id
            ),

          env.DB
            .prepare(`
              INSERT INTO family_members
              (
                family_id,
                user_id,
                role
              )
              VALUES (?, ?, 'admin')
            `)
            .bind(
              familyId,
              user.id
            )
        ]);

        return json(
          {
            ok: true,
            family: {
              id: familyId,
              name: familyName,
              role: "admin"
            }
          },
          201
        );
      }

      // =========================================================
      // EDITAR NOME DA FAMÍLIA
      // =========================================================

      const familyPatchMatch =
        url.pathname.match(/^\/families\/([^/]+)$/);

      if (
        familyPatchMatch &&
        request.method === "PATCH"
      ) {
        const familyId =
          decodeURIComponent(familyPatchMatch[1]);

        await requireFamilyAdmin(
          user.id,
          familyId
        );

        const body = await request.json();

        const name =
          String(body.name || "").trim();

        if (!name) {
          return json(
            {
              ok: false,
              error: "Nome da família é obrigatório"
            },
            400
          );
        }

        await env.DB
          .prepare(`
            UPDATE families
            SET
              name = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            name,
            familyId
          )
          .run();

        return json({
          ok: true,
          family: {
            id: familyId,
            name
          }
        });
      }

      // =========================================================
      // CONSULTAR UMA FAMÍLIA
      // =========================================================

      const familyGetMatch =
        url.pathname.match(/^\/families\/([^/]+)$/);

      if (
        familyGetMatch &&
        request.method === "GET"
      ) {
        const familyId =
          decodeURIComponent(familyGetMatch[1]);

        await requireFamilyMember(
          user.id,
          familyId
        );

        const family = await env.DB
          .prepare(`
            SELECT
              id,
              name,
              created_by,
              created_at,
              updated_at,
              drive_folder_id,
              drive_data_file_id,
              drive_photos_folder_id
            FROM families
            WHERE id = ?
            LIMIT 1
          `)
          .bind(familyId)
          .first();

        return json({
          ok: true,
          family
        });
      }

      // =========================================================
      // ARMAZENAMENTO COMPARTILHADO DA FAMÍLIA
      // =========================================================

      if (
        url.pathname === "/families/drive-storage" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const familyId =
          String(body.family_id || "").trim();

        const folderId =
          String(body.drive_folder_id || "").trim();

        const dataFileId =
          String(body.drive_data_file_id || "").trim();

        const photosFolderId =
          String(body.drive_photos_folder_id || "").trim();

        if (!familyId || !folderId || !dataFileId) {
          return json(
            {
              ok: false,
              error:
                "family_id, drive_folder_id e drive_data_file_id são obrigatórios"
            },
            400
          );
        }

        await requireFamilyAdmin(
          user.id,
          familyId
        );

        if (photosFolderId) {
          await env.DB
            .prepare(`
              UPDATE families
              SET
                drive_folder_id = ?,
                drive_data_file_id = ?,
                drive_photos_folder_id = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `)
            .bind(
              folderId,
              dataFileId,
              photosFolderId,
              familyId
            )
            .run();
        } else {
          await env.DB
            .prepare(`
              UPDATE families
              SET
                drive_folder_id = ?,
                drive_data_file_id = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `)
            .bind(
              folderId,
              dataFileId,
              familyId
            )
            .run();
        }

        return json({
          ok: true,
          family_id: familyId,
          drive_folder_id: folderId,
          drive_data_file_id: dataFileId,
          drive_photos_folder_id:
            photosFolderId || null
        });
      }

      // =========================================================
      // MEMBROS
      // =========================================================

      if (
        url.pathname === "/family-members" &&
        request.method === "GET"
      ) {
        const familyId =
          url.searchParams.get("family_id");

        if (!familyId) {
          return json(
            {
              ok: false,
              error: "family_id é obrigatório"
            },
            400
          );
        }

        await requireFamilyMember(
          user.id,
          familyId
        );

        const result = await env.DB
          .prepare(`
            SELECT
              u.id,
              u.name,
              u.email,
              u.picture_url,
              fm.role,
              fm.joined_at
            FROM family_members fm
            JOIN users u
              ON u.id = fm.user_id
            WHERE fm.family_id = ?
            ORDER BY fm.joined_at
          `)
          .bind(familyId)
          .all();

        return json({
          ok: true,
          members: result.results
        });
      }

      // =========================================================
      // CONVITES
      // =========================================================

      if (
        url.pathname === "/invites" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const familyId =
          String(body.family_id || "").trim();

        const email =
          normalizeEmail(body.email);

        const role =
          [
            "admin",
            "responsavel",
            "visualizador"
          ].includes(body.role)
            ? body.role
            : "responsavel";

        if (!familyId || !email) {
          return json(
            {
              ok: false,
              error:
                "family_id e email são obrigatórios"
            },
            400
          );
        }

        await requireFamilyAdmin(
          user.id,
          familyId
        );

        const existingMember =
          await env.DB
            .prepare(`
              SELECT fm.user_id
              FROM family_members fm
              JOIN users u
                ON u.id = fm.user_id
              WHERE fm.family_id = ?
                AND LOWER(u.email) = LOWER(?)
              LIMIT 1
            `)
            .bind(
              familyId,
              email
            )
            .first();

        if (existingMember) {
          return json(
            {
              ok: false,
              error:
                "Este usuário já pertence à família"
            },
            409
          );
        }

        const existingInvite =
          await env.DB
            .prepare(`
              SELECT id
              FROM invites
              WHERE family_id = ?
                AND LOWER(email) = LOWER(?)
                AND status = 'pending'
              LIMIT 1
            `)
            .bind(
              familyId,
              email
            )
            .first();

        if (existingInvite) {
          return json(
            {
              ok: false,
              error:
                "Já existe um convite pendente para este e-mail"
            },
            409
          );
        }

        const inviteId = newId("inv");

        await env.DB
          .prepare(`
            INSERT INTO invites
            (
              id,
              family_id,
              email,
              role,
              invited_by,
              token,
              status
            )
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
          `)
          .bind(
            inviteId,
            familyId,
            email,
            role,
            user.id,
            crypto.randomUUID()
          )
          .run();

        return json(
          {
            ok: true,
            invite: {
              id: inviteId,
              family_id: familyId,
              email,
              role
            }
          },
          201
        );
      }

      if (
        url.pathname === "/invites/accept" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const inviteId =
          String(body.invite_id || "").trim();

        const invite = await env.DB
          .prepare(`
            SELECT *
            FROM invites
            WHERE id = ?
              AND status = 'pending'
            LIMIT 1
          `)
          .bind(inviteId)
          .first();

        if (!invite) {
          return json(
            {
              ok: false,
              error:
                "Convite não encontrado ou não está mais pendente"
            },
            404
          );
        }

        if (
          normalizeEmail(invite.email) !==
          normalizeEmail(user.email)
        ) {
          return json(
            {
              ok: false,
              error:
                "Este convite pertence a outro e-mail"
            },
            403
          );
        }

        await env.DB.batch([
          env.DB
            .prepare(`
              INSERT OR IGNORE INTO family_members
              (
                family_id,
                user_id,
                role
              )
              VALUES (?, ?, ?)
            `)
            .bind(
              invite.family_id,
              user.id,
              invite.role
            ),

          env.DB
            .prepare(`
              UPDATE invites
              SET
                status = 'accepted',
                accepted_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `)
            .bind(invite.id)
        ]);

        return json({
          ok: true,
          family_id: invite.family_id,
          message: "Convite aceito"
        });
      }

      if (
        url.pathname === "/invites/decline" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const invite = await env.DB
          .prepare(`
            SELECT *
            FROM invites
            WHERE id = ?
              AND status = 'pending'
            LIMIT 1
          `)
          .bind(body.invite_id)
          .first();

        if (!invite) {
          return json(
            {
              ok: false,
              error: "Convite não encontrado"
            },
            404
          );
        }

        if (
          normalizeEmail(invite.email) !==
          normalizeEmail(user.email)
        ) {
          return json(
            {
              ok: false,
              error:
                "Este convite pertence a outro e-mail"
            },
            403
          );
        }

        await env.DB
          .prepare(`
            UPDATE invites
            SET status = 'declined'
            WHERE id = ?
          `)
          .bind(invite.id)
          .run();

        return json({
          ok: true,
          message: "Convite recusado"
        });
      }

      // =========================================================
      // CRIANÇAS
      // =========================================================

      if (
        url.pathname === "/children" &&
        request.method === "GET"
      ) {
        const familyId =
          url.searchParams.get("family_id");

        const includeArchived =
          url.searchParams.get("include_archived") === "1";

        if (!familyId) {
          return json(
            {
              ok: false,
              error: "family_id é obrigatório"
            },
            400
          );
        }

        await requireFamilyMember(
          user.id,
          familyId
        );

        const sql =
          includeArchived
            ? `
              SELECT *
              FROM children
              WHERE family_id = ?
              ORDER BY active DESC, name
            `
            : `
              SELECT *
              FROM children
              WHERE family_id = ?
                AND active = 1
              ORDER BY name
            `;

        const result =
          await env.DB
            .prepare(sql)
            .bind(familyId)
            .all();

        return json({
          ok: true,
          children: result.results
        });
      }

      if (
        url.pathname === "/children" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const familyId =
          String(body.family_id || "").trim();

        const name =
          String(body.name || "").trim();

        if (!familyId || !name) {
          return json(
            {
              ok: false,
              error:
                "family_id e name são obrigatórios"
            },
            400
          );
        }

        const member =
          await requireFamilyMember(
            user.id,
            familyId
          );

        if (member.role === "visualizador") {
          return json(
            {
              ok: false,
              error:
                "Usuário possui somente permissão de visualização"
            },
            403
          );
        }

        const childId = newId("child");

        await env.DB
          .prepare(`
            INSERT INTO children
            (
              id,
              family_id,
              name,
              birth_date,
              reference_stage,
              notes
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .bind(
            childId,
            familyId,
            name,
            body.birth_date || null,
            body.reference_stage || null,
            body.notes || null
          )
          .run();

        return json(
          {
            ok: true,
            child: {
              id: childId,
              family_id: familyId,
              name,
              birth_date:
                body.birth_date || null,
              reference_stage:
                body.reference_stage || null,
              active: 1
            }
          },
          201
        );
      }

      // =========================================================
      // EDITAR CRIANÇA
      // =========================================================

      const childPatchMatch =
        url.pathname.match(/^\/children\/([^/]+)$/);

      if (
        childPatchMatch &&
        request.method === "PATCH"
      ) {
        const childId =
          decodeURIComponent(childPatchMatch[1]);

        const child = await env.DB
          .prepare(`
            SELECT *
            FROM children
            WHERE id = ?
            LIMIT 1
          `)
          .bind(childId)
          .first();

        if (!child) {
          return json(
            {
              ok: false,
              error: "Criança não encontrada"
            },
            404
          );
        }

        const member =
          await requireFamilyMember(
            user.id,
            child.family_id
          );

        if (member.role === "visualizador") {
          return json(
            {
              ok: false,
              error:
                "Usuário possui somente permissão de visualização"
            },
            403
          );
        }

        const body = await request.json();

        const name =
          String(body.name || child.name || "").trim();

        if (!name) {
          return json(
            {
              ok: false,
              error: "Nome da criança é obrigatório"
            },
            400
          );
        }

        await env.DB
          .prepare(`
            UPDATE children
            SET
              name = ?,
              birth_date = ?,
              reference_stage = ?,
              notes = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            name,
            body.birth_date ?? child.birth_date,
            body.reference_stage ?? child.reference_stage,
            body.notes ?? child.notes,
            childId
          )
          .run();

        const updated = await env.DB
          .prepare(`
            SELECT *
            FROM children
            WHERE id = ?
          `)
          .bind(childId)
          .first();

        return json({
          ok: true,
          child: updated
        });
      }

      // =========================================================
      // ARQUIVAR CRIANÇA
      // =========================================================

      const archiveMatch =
        url.pathname.match(
          /^\/children\/([^/]+)\/archive$/
        );

      if (
        archiveMatch &&
        request.method === "POST"
      ) {
        const childId =
          decodeURIComponent(archiveMatch[1]);

        const child =
          await env.DB
            .prepare(`
              SELECT *
              FROM children
              WHERE id = ?
              LIMIT 1
            `)
            .bind(childId)
            .first();

        if (!child) {
          return json(
            {
              ok: false,
              error: "Criança não encontrada"
            },
            404
          );
        }

        await requireFamilyAdmin(
          user.id,
          child.family_id
        );

        await env.DB
          .prepare(`
            UPDATE children
            SET
              active = 0,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(childId)
          .run();

        return json({
          ok: true,
          message: "Criança arquivada",
          child_id: childId
        });
      }

      // =========================================================
      // RESTAURAR CRIANÇA
      // =========================================================

      const restoreMatch =
        url.pathname.match(
          /^\/children\/([^/]+)\/restore$/
        );

      if (
        restoreMatch &&
        request.method === "POST"
      ) {
        const childId =
          decodeURIComponent(restoreMatch[1]);

        const child =
          await env.DB
            .prepare(`
              SELECT *
              FROM children
              WHERE id = ?
              LIMIT 1
            `)
            .bind(childId)
            .first();

        if (!child) {
          return json(
            {
              ok: false,
              error: "Criança não encontrada"
            },
            404
          );
        }

        await requireFamilyAdmin(
          user.id,
          child.family_id
        );

        await env.DB
          .prepare(`
            UPDATE children
            SET
              active = 1,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(childId)
          .run();

        return json({
          ok: true,
          message: "Criança restaurada",
          child_id: childId
        });
      }

      // =========================================================
      // MERGE DE CRIANÇAS — DEFINITIVO
      // =========================================================

      if (
        url.pathname === "/children/merge" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const keepId =
          String(body.keep_id || "").trim();

        const mergeId =
          String(body.merge_id || "").trim();

        if (
          !keepId ||
          !mergeId ||
          keepId === mergeId
        ) {
          return json(
            {
              ok: false,
              error:
                "keep_id e merge_id válidos são obrigatórios"
            },
            400
          );
        }

        const keep = await env.DB
          .prepare(`
            SELECT *
            FROM children
            WHERE id = ?
            LIMIT 1
          `)
          .bind(keepId)
          .first();

        const merge = await env.DB
          .prepare(`
            SELECT *
            FROM children
            WHERE id = ?
            LIMIT 1
          `)
          .bind(mergeId)
          .first();

        if (!keep || !merge) {
          return json(
            {
              ok: false,
              error: "Criança não encontrada"
            },
            404
          );
        }

        if (
          keep.family_id !==
          merge.family_id
        ) {
          return json(
            {
              ok: false,
              error:
                "As crianças não pertencem à mesma família"
            },
            400
          );
        }

        await requireFamilyAdmin(
          user.id,
          keep.family_id
        );

        // Transfere as atividades da duplicata.
        await env.DB
          .prepare(`
            UPDATE activities
            SET child_id = ?
            WHERE child_id = ?
          `)
          .bind(keepId, mergeId)
          .run();

        // Transfere habilidades personalizadas.
        // Se houver alguma restrição de unicidade no banco, remove primeiro
        // os registros da duplicata que já existam para a criança mantida.
        try {
          await env.DB
            .prepare(`
              DELETE FROM family_custom_skills
              WHERE child_id = ?
                AND EXISTS (
                  SELECT 1
                  FROM family_custom_skills k
                  WHERE k.child_id = ?
                    AND k.code = family_custom_skills.code
                )
            `)
            .bind(mergeId, keepId)
            .run();
        } catch (_) {
          // Mantém compatibilidade com esquemas antigos sem coluna code
          // ou sem family_custom_skills configurada.
        }

        try {
          await env.DB
            .prepare(`
              UPDATE family_custom_skills
              SET child_id = ?
              WHERE child_id = ?
            `)
            .bind(keepId, mergeId)
            .run();
        } catch (_) {
          // A base oficial BNCC não depende desta tabela.
        }

        // A diferença essencial da 0.7.2:
        // a duplicata NÃO é arquivada. Ela é apagada fisicamente.
        await env.DB
          .prepare(`
            DELETE FROM children
            WHERE id = ?
              AND family_id = ?
          `)
          .bind(mergeId, keep.family_id)
          .run();

        return json({
          ok: true,
          keep_id: keepId,
          merged_id: mergeId,
          deleted: true,
          message:
            "Crianças unificadas e cadastro duplicado excluído definitivamente"
        });
      }

      // Exclusão definitiva usada como fallback pelo frontend quando
      // somente o cadastro duplicado possui vínculo conhecido no backend.
      const deleteChildMatch =
        url.pathname.match(
          /^\/children\/([^/]+)\/delete$/
        );

      if (
        deleteChildMatch &&
        request.method === "DELETE"
      ) {
        const childId =
          decodeURIComponent(deleteChildMatch[1]);

        const child = await env.DB
          .prepare(`
            SELECT *
            FROM children
            WHERE id = ?
            LIMIT 1
          `)
          .bind(childId)
          .first();

        if (!child) {
          return json({
            ok: true,
            deleted: false,
            child_id: childId,
            message: "Cadastro já não existe"
          });
        }

        await requireFamilyAdmin(
          user.id,
          child.family_id
        );

        // Segurança: não apaga cadastro que ainda possua atividades.
        // O caminho normal de merge transfere essas referências primeiro.
        const activityCount = await env.DB
          .prepare(`
            SELECT COUNT(*) AS total
            FROM activities
            WHERE child_id = ?
          `)
          .bind(childId)
          .first();

        if (Number(activityCount?.total || 0) > 0) {
          return json(
            {
              ok: false,
              error:
                "A criança ainda possui atividades. Use /children/merge para preservar os registros."
            },
            409
          );
        }

        try {
          await env.DB
            .prepare(`
              DELETE FROM family_custom_skills
              WHERE child_id = ?
            `)
            .bind(childId)
            .run();
        } catch (_) {}

        await env.DB
          .prepare(`
            DELETE FROM children
            WHERE id = ?
          `)
          .bind(childId)
          .run();

        return json({
          ok: true,
          deleted: true,
          child_id: childId,
          message: "Cadastro excluído definitivamente"
        });
      }

      // =========================================================
      // BNCC - BASE OFICIAL NO D1
      // =========================================================

      if (
        url.pathname === "/bncc" &&
        request.method === "GET"
      ) {
        const q =
          String(
            url.searchParams.get("q") || ""
          ).trim();

        const code =
          String(
            url.searchParams.get("code") || ""
          ).trim();

        const year =
          String(
            url.searchParams.get("year") || ""
          ).trim();

        const component =
          String(
            url.searchParams.get("component") || ""
          ).trim();

        const area =
          String(
            url.searchParams.get("area") || ""
          ).trim();

        const coversMultipleYears =
          String(
            url.searchParams.get("covers_multiple_years") || ""
          ).trim();

        const requestedLimit =
          Number(
            url.searchParams.get("limit") || 150
          );

        const limit =
          Number.isFinite(requestedLimit)
            ? Math.min(
                Math.max(
                  Math.trunc(requestedLimit),
                  1
                ),
                300
              )
            : 150;

        let sql = `
          SELECT
            id,
            code,
            education_stage,
            school_year,
            knowledge_area,
            curricular_component,
            thematic_unit,
            knowledge_object,
            covers_multiple_years,
            description
          FROM bncc_skills
          WHERE 1 = 1
        `;

        const params = [];

        if (q) {
          const likeQ = `%${q}%`;

          sql += `
            AND (
              code LIKE ? COLLATE NOCASE
              OR description LIKE ? COLLATE NOCASE
              OR curricular_component LIKE ? COLLATE NOCASE
              OR knowledge_area LIKE ? COLLATE NOCASE
              OR school_year LIKE ? COLLATE NOCASE
            )
          `;

          params.push(
            likeQ,
            likeQ,
            likeQ,
            likeQ,
            likeQ
          );
        }

        if (code) {
          sql += `
            AND code = ? COLLATE NOCASE
          `;

          params.push(code);
        }

        if (year) {
          sql += `
            AND school_year = ? COLLATE NOCASE
          `;

          params.push(year);
        }

        if (component) {
          sql += `
            AND curricular_component = ? COLLATE NOCASE
          `;

          params.push(component);
        }

        if (area) {
          sql += `
            AND knowledge_area = ? COLLATE NOCASE
          `;

          params.push(area);
        }

        if (coversMultipleYears) {
          sql += `
            AND covers_multiple_years = ? COLLATE NOCASE
          `;

          params.push(coversMultipleYears);
        }

        sql += `
          ORDER BY
            curricular_component,
            school_year,
            code
          LIMIT ?
        `;

        params.push(limit);

        const result =
          await env.DB
            .prepare(sql)
            .bind(...params)
            .all();

        return json({
          ok: true,
          count: result.results.length,
          filters: {
            q: q || null,
            code: code || null,
            year: year || null,
            component: component || null,
            area: area || null,
            covers_multiple_years:
              coversMultipleYears || null,
            limit
          },
          skills: result.results
        });
      }


      // =========================================================
      // BNCC — ÍNDICE SEMÂNTICO (v0.14)
      // =========================================================
      const EMBEDDING_MODEL = "gemini-embedding-2";
      const EMBEDDING_DIMENSIONS = 768;

      async function createEmbedding(text, kind="document", tracking=null) {
        const prefix = kind === "query"
          ? "task: search result | query: "
          : "title: Habilidade BNCC | text: ";
        const inputText=prefix + String(text||"").slice(0,5000);
        const embeddingController=new AbortController();
        const embeddingTimer=setTimeout(()=>embeddingController.abort(),20000);
        let r;
        try{
          r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`,
            {
              method: "POST",
              headers: {"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
              body: JSON.stringify({
                content:{parts:[{text:inputText}]},
                output_dimensionality: EMBEDDING_DIMENSIONS
              }),
              signal:embeddingController.signal
            }
          );
        }catch(e){
          if(e?.name==="AbortError"&&tracking){
            await recordAiUsage({...tracking,userId:user.id,model:EMBEDDING_MODEL,usage:{},tokenCountSource:"provider",status:"timeout",providerStatus:null});
          }
          if(e?.name==="AbortError")throw Object.assign(new Error("O embedding demorou mais que o esperado"),{code:"EMBEDDING_TIMEOUT",aiStage:"semantic_search"});
          throw e;
        }finally{clearTimeout(embeddingTimer)}
        const data=await r.json().catch(()=>({}));
        if(tracking){
          const providerUsage=data?.usageMetadata||{};
          const providerTokens=aiUsageNumber(providerUsage,"promptTokenCount","prompt_tokens","totalTokenCount","total_tokens");
          const usage=providerTokens?providerUsage:{prompt_tokens:Math.max(1,Math.ceil(inputText.length/4)),total_tokens:Math.max(1,Math.ceil(inputText.length/4))};
          await recordAiUsage({...tracking,userId:user.id,model:EMBEDDING_MODEL,usage,tokenCountSource:providerTokens?"provider":"estimated_chars",status:r.ok?"success":"provider_error",providerStatus:r.status});
        }
        if(!r.ok){
          const providerMessage=String(data?.error?.message||data?.message||`HTTP ${r.status}`).replace(/\s+/g," ").slice(0,240);
          const err = Object.assign(
            new Error(`Embedding API ${r.status}: ${providerMessage}`),
            {
              providerStatus: r.status,
              retryAfterSeconds: Math.max(
                0,
                Number(r.headers.get("retry-after")) || 0
              )
            }
          );
          throw err;
        }
        const values=data?.embedding?.values || data?.embeddings?.[0]?.values || [];
        if(!Array.isArray(values)||values.length!==EMBEDDING_DIMENSIONS) throw new Error("EMBEDDING_INVALID_RESPONSE");
        return values;
      }

      function cosineSimilarity(a,b){
        if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return -1;
        let dot=0,aa=0,bb=0;
        for(let i=0;i<a.length;i++){const x=Number(a[i])||0,y=Number(b[i])||0;dot+=x*y;aa+=x*x;bb+=y*y;}
        return aa&&bb?dot/(Math.sqrt(aa)*Math.sqrt(bb)):-1;
      }

      if(url.pathname==="/admin/bncc-embeddings/status"&&request.method==="GET"){
        requireGlobalAdmin(user);
        const totalRow=await env.DB.prepare(`SELECT COUNT(*) AS n FROM bncc_skills`).first();
        const readyRow=await env.DB.prepare(`SELECT COUNT(*) AS n FROM bncc_embeddings WHERE model=? AND dimensions=?`).bind(EMBEDDING_MODEL,EMBEDDING_DIMENSIONS).first();
        return json({ok:true,total:Number(totalRow?.n||0),ready:Number(readyRow?.n||0),model:EMBEDDING_MODEL,dimensions:EMBEDDING_DIMENSIONS});
      }

      if(url.pathname==="/admin/bncc-embeddings/build"&&request.method==="POST"){
        requireGlobalAdmin(user);
        if(!env.GEMINI_API_KEY)return json({ok:false,error:"GEMINI_API_KEY não configurada"},500);
        const body=await request.json().catch(()=>({}));
        // Ritmo deliberadamente abaixo do limite gratuito de 100 RPM.
        const limit=Math.max(1,Math.min(8,Number(body.limit)||8));
        const missing=await env.DB.prepare(`
          SELECT b.id,b.code,b.school_year,b.knowledge_area,b.curricular_component,b.thematic_unit,b.knowledge_object,b.description
          FROM bncc_skills b
          LEFT JOIN bncc_embeddings e ON e.bncc_code=b.code AND e.model=? AND e.dimensions=?
          WHERE e.bncc_code IS NULL
          ORDER BY b.id LIMIT ?
        `).bind(EMBEDDING_MODEL,EMBEDDING_DIMENSIONS,limit).all();
        let processed=0;
        for(const skill of missing.results){
          const doc=[skill.code,skill.school_year,skill.knowledge_area,skill.curricular_component,skill.thematic_unit,skill.knowledge_object,skill.description].filter(Boolean).join(" | ");
          try{
            const vector=await createEmbedding(doc,"document");
            await env.DB.prepare(`INSERT OR REPLACE INTO bncc_embeddings (bncc_code,model,dimensions,vector_json,updated_at) VALUES (?,?,?,?,datetime('now'))`).bind(skill.code,EMBEDDING_MODEL,EMBEDDING_DIMENSIONS,JSON.stringify(vector)).run();
            processed++;
          }catch(e){
            console.error("Embedding build error",skill.code,e.message);
            const totalRow=await env.DB.prepare(`SELECT COUNT(*) AS n FROM bncc_skills`).first();
            const readyRow=await env.DB.prepare(`SELECT COUNT(*) AS n FROM bncc_embeddings WHERE model=? AND dimensions=?`).bind(EMBEDDING_MODEL,EMBEDDING_DIMENSIONS).first();
            const total=Number(totalRow?.n||0),ready=Number(readyRow?.n||0);
            if(Number(e?.providerStatus)===429){
              return json({ok:true,paused:true,provider_status:429,retry_after_seconds:Math.max(65,Number(e?.retryAfterSeconds)||0),processed,total,ready,done:false,bncc_code:skill.code,message:`Limite temporário da API ao preparar ${skill.code}. O processo pode retomar automaticamente.`});
            }
            return json({ok:false,error:`Falha ao preparar ${skill.code}: ${e.message||"erro de embedding"}`,provider_status:Number(e?.providerStatus)||null,bncc_code:skill.code,processed,total,ready},502);
          }
          // 1 s entre embeddings ~= 60 RPM no máximo, deixando margem para consultas de uso normal.
          await new Promise(r=>setTimeout(r,1000));
        }
        const totalRow=await env.DB.prepare(`SELECT COUNT(*) AS n FROM bncc_skills`).first();
        const readyRow=await env.DB.prepare(`SELECT COUNT(*) AS n FROM bncc_embeddings WHERE model=? AND dimensions=?`).bind(EMBEDDING_MODEL,EMBEDDING_DIMENSIONS).first();
        const total=Number(totalRow?.n||0),ready=Number(readyRow?.n||0);
        return json({ok:true,processed,total,ready,done:total>0&&ready>=total,model:EMBEDDING_MODEL,dimensions:EMBEDDING_DIMENSIONS});
      }


      // =========================================================
      // CATÁLOGO COMUNITÁRIO DE LIVROS + BIBLIOTECA DA FAMÍLIA
      // =========================================================
      if(url.pathname==="/community-books/search"&&request.method==="GET"){
        const q=String(url.searchParams.get("q")||"").trim();
        if(q.length<2)return json({ok:true,items:[]});
        const like=`%${q}%`;
        const rs=await env.DB.prepare(`
          SELECT * FROM community_books
          WHERE status='approved' AND merged_into_id IS NULL
            AND (title LIKE ? COLLATE NOCASE OR authors_json LIKE ? COLLATE NOCASE OR isbn13 LIKE ? COLLATE NOCASE OR isbn10 LIKE ? COLLATE NOCASE)
          ORDER BY updated_at DESC LIMIT 8
        `).bind(like,like,like,like).all();
        return json({ok:true,source:"community",items:(rs.results||[]).map(b=>({source:"community",community_book_id:b.id,title:b.title,authors:JSON.parse(b.authors_json||"[]"),publisher:b.publisher||"",published_date:b.published_date||"",description:b.description||"",isbn13:b.isbn13||"",isbn10:b.isbn10||"",page_count:b.page_count||null,categories:JSON.parse(b.categories_json||"[]"),language:b.language||"",thumbnail:b.cover_url||""}))});
      }

      if(url.pathname==="/community-books"&&request.method==="POST"){
        const body=await request.json(),familyId=String(body.family_id||"").trim(),childId=String(body.child_id||"").trim(),title=String(body.title||"").trim();
        if(!familyId||!childId||!title)return json({ok:false,error:"Família, criança e título são obrigatórios"},400);
        await requireFamilyMember(user.id,familyId);
        const child=await env.DB.prepare(`SELECT id FROM children WHERE id=? AND family_id=? AND active=1 LIMIT 1`).bind(childId,familyId).first();
        if(!child)return json({ok:false,error:"Criança não encontrada nesta família"},404);
        const authors=Array.isArray(body.authors)?body.authors.map(x=>String(x).trim()).filter(Boolean):[];
        const isbn13=String(body.isbn13||"").replace(/\D/g,""),isbn10=String(body.isbn10||"").replace(/\D/g,"");
        // Duplicate hint: reuse approved canonical book if ISBN is exact.
        let existing=null;
        if(isbn13)existing=await env.DB.prepare(`SELECT id FROM community_books WHERE status='approved' AND isbn13=? AND merged_into_id IS NULL LIMIT 1`).bind(isbn13).first();
        if(!existing&&isbn10)existing=await env.DB.prepare(`SELECT id FROM community_books WHERE status='approved' AND isbn10=? AND merged_into_id IS NULL LIMIT 1`).bind(isbn10).first();
        let bookId=existing?.id||"";
        if(!bookId){
          bookId=newId("book");
          await env.DB.prepare(`INSERT INTO community_books(id,title,authors_json,publisher,isbn13,isbn10,cover_url,status,requested_by_family_id,requested_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
            .bind(bookId,title,JSON.stringify(authors),String(body.publisher||"").trim(),isbn13,isbn10,String(body.cover_data||"").trim(),"pending",familyId,user.id).run();
        }
        const familyBookId=newId("fbook");
        const readingStatus=["Planejado","Lendo"].includes(String(body.status||""))?String(body.status):"Lendo";
        await env.DB.prepare(`INSERT INTO family_books(id,family_id,child_id,source,community_book_id,status,started_at,target_finish_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
          .bind(familyBookId,familyId,childId,"community",bookId,readingStatus,String(body.started_at||new Date().toISOString().slice(0,10)),String(body.target_finish_at||"")||null).run();
        return json({ok:true,community_book_id:bookId,family_book_id:familyBookId,catalog_status:existing?"approved":"pending"});
      }

      // Administrador global publica diretamente no catálogo, sem criar
      // qualquer vínculo com família ou criança.
      if(url.pathname==="/community-books/admin"&&request.method==="POST"){
        requireGlobalAdmin(user);
        const body=await request.json().catch(()=>({})),title=String(body.title||"").trim();
        if(!title)return json({ok:false,error:"Título é obrigatório"},400);
        const authors=Array.isArray(body.authors)?body.authors.map(x=>String(x).trim()).filter(Boolean):[];
        const isbn13=String(body.isbn13||"").replace(/\D/g,""),isbn10=String(body.isbn10||"").replace(/\D/g,"");
        let existing=null;
        if(isbn13)existing=await env.DB.prepare(`SELECT id,title FROM community_books WHERE status='approved' AND isbn13=? AND merged_into_id IS NULL LIMIT 1`).bind(isbn13).first();
        if(!existing&&isbn10)existing=await env.DB.prepare(`SELECT id,title FROM community_books WHERE status='approved' AND isbn10=? AND merged_into_id IS NULL LIMIT 1`).bind(isbn10).first();
        if(existing)return json({ok:false,error:`Este ISBN já pertence ao livro “${existing.title}”`,community_book_id:existing.id},409);
        const id=newId("book");
        await env.DB.prepare(`INSERT INTO community_books(id,title,authors_json,publisher,published_date,description,isbn13,isbn10,page_count,categories_json,language,cover_url,status,requested_by_family_id,requested_by_user_id,reviewed_by_user_id,reviewed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,? ,NULL,?,?,datetime('now'),datetime('now'),datetime('now'))`)
          .bind(id,title,JSON.stringify(authors),String(body.publisher||"").trim(),String(body.published_date||"").trim(),String(body.description||"").trim(),isbn13,isbn10,Number.isFinite(Number(body.page_count))?Number(body.page_count):null,JSON.stringify(Array.isArray(body.categories)?body.categories:[]),String(body.language||"").trim(),String(body.thumbnail||"").trim(),"approved",user.id,user.id).run();
        return json({ok:true,community_book_id:id,status:"approved"});
      }

      if(url.pathname==="/family-books"&&request.method==="POST"){
        try{
          const body=await request.json();
          const familyId=String(body.family_id||"").trim();
          const childId=String(body.child_id||"").trim();
          const source=body.community_book_id?"community":"google_books";
          if(!familyId||!childId)return json({ok:false,error:"Família e criança são obrigatórias"},400);

          await requireFamilyMember(user.id,familyId);

          // Do not depend on the optional/legacy `active` field here.
          const child=await env.DB.prepare(`SELECT id FROM children WHERE id=? AND family_id=? LIMIT 1`)
            .bind(childId,familyId).first();
          if(!child)return json({ok:false,error:"Criança não encontrada nesta família"},404);

          const id=newId("fbook");
          await env.DB.prepare(`
            INSERT INTO family_books(
              id,family_id,child_id,source,google_volume_id,community_book_id,
              title_snapshot,authors_json_snapshot,publisher_snapshot,published_date_snapshot,
              isbn13_snapshot,isbn10_snapshot,page_count_snapshot,categories_json_snapshot,
              language_snapshot,description_snapshot,cover_url_snapshot,status,started_at,target_finish_at,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
          `).bind(
            id,familyId,childId,source,
            String(body.google_volume_id||""),
            body.community_book_id ? String(body.community_book_id) : null,
            String(body.title||""),
            JSON.stringify(Array.isArray(body.authors)?body.authors:[]),
            String(body.publisher||""),
            String(body.published_date||""),
            String(body.isbn13||""),
            String(body.isbn10||""),
            Number.isFinite(Number(body.page_count))?Number(body.page_count):null,
            JSON.stringify(Array.isArray(body.categories)?body.categories:[]),
            String(body.language||""),
            String(body.description||""),
            String(body.thumbnail||""),
            ["Planejado","Lendo"].includes(String(body.status||""))?String(body.status):"Lendo",
            String(body.started_at||new Date().toISOString().slice(0,10)),
            String(body.target_finish_at||"")||null
          ).run();

          return json({ok:true,id});
        }catch(e){
          console.error("family-books POST:",e);
          return json({ok:false,error:"Não foi possível adicionar o livro: "+String(e?.message||e),detail:String(e?.message||e)},500);
        }
      }

      if(url.pathname==="/family-books"&&request.method==="GET"){
        const familyId=String(url.searchParams.get("family_id")||"").trim(),childId=String(url.searchParams.get("child_id")||"").trim();
        if(!familyId||!childId)return json({ok:false,error:"Família e criança são obrigatórias"},400);
        await requireFamilyMember(user.id,familyId);
        const rs=await env.DB.prepare(`
          SELECT fb.*,
            cb.title AS cb_title,cb.authors_json AS cb_authors,cb.publisher AS cb_publisher,cb.published_date AS cb_published_date,
            cb.isbn13 AS cb_isbn13,cb.isbn10 AS cb_isbn10,cb.page_count AS cb_page_count,cb.categories_json AS cb_categories,
            cb.language AS cb_language,cb.description AS cb_description,cb.cover_url AS cb_cover,cb.status AS catalog_status
          FROM family_books fb LEFT JOIN community_books cb ON cb.id=fb.community_book_id
          WHERE fb.family_id=? AND fb.child_id=? ORDER BY fb.created_at DESC
        `).bind(familyId,childId).all();
        const books=(rs.results||[]).map(b=>{
          const community=!!b.community_book_id;
          return {backend:true,id:b.id,child_id:b.child_id,source:b.source,google_volume_id:b.google_volume_id||"",community_book_id:b.community_book_id||"",title:community?(b.cb_title||b.title_snapshot||""):(b.title_snapshot||""),authors:JSON.parse((community?b.cb_authors:b.authors_json_snapshot)||"[]"),publisher:(community?b.cb_publisher:b.publisher_snapshot)||"",published_date:(community?b.cb_published_date:b.published_date_snapshot)||"",isbn13:(community?b.cb_isbn13:b.isbn13_snapshot)||"",isbn10:(community?b.cb_isbn10:b.isbn10_snapshot)||"",page_count:(community?b.cb_page_count:b.page_count_snapshot)||null,categories:JSON.parse((community?b.cb_categories:b.categories_json_snapshot)||"[]"),language:(community?b.cb_language:b.language_snapshot)||"",description:(community?b.cb_description:b.description_snapshot)||"",thumbnail:(community?b.cb_cover:b.cover_url_snapshot)||"",catalog_status:b.catalog_status||"",status:b.status||"Lendo",started_at:b.started_at||"",target_finish_at:b.target_finish_at||"",finished_at:b.finished_at||"",completion_activity_id:b.completion_activity_id||""}
        });
        return json({ok:true,books});
      }

      const familyBookMatch=url.pathname.match(/^\/family-books\/([^/]+)$/);
      if(familyBookMatch&&request.method==="PATCH"){
        const id=decodeURIComponent(familyBookMatch[1]),existing=await env.DB.prepare(`SELECT * FROM family_books WHERE id=? LIMIT 1`).bind(id).first();
        if(!existing)return json({ok:false,error:"Livro da família não encontrado"},404);
        await requireFamilyMember(user.id,existing.family_id);
        const body=await request.json();
        const status=body.status!==undefined?String(body.status||"").trim():null;
        const startedAt=body.started_at!==undefined?String(body.started_at||"").trim():null;
        const finishedAt=body.finished_at!==undefined?String(body.finished_at||"").trim():null;
        const targetFinishAt=body.target_finish_at!==undefined?String(body.target_finish_at||"").trim():null;
        const completionActivityId=body.completion_activity_id!==undefined?String(body.completion_activity_id||"").trim():null;
        if(status!==null&&!["Planejado","Lendo","Concluído"].includes(status))return json({ok:false,error:"Status inválido"},400);
        if(startedAt!==null&&startedAt&&!/^\d{4}-\d{2}-\d{2}$/.test(startedAt))return json({ok:false,error:"Data de início inválida"},400);
        if(finishedAt!==null&&finishedAt&&!/^\d{4}-\d{2}-\d{2}$/.test(finishedAt))return json({ok:false,error:"Data de conclusão inválida"},400);
        if(targetFinishAt!==null&&targetFinishAt&&!/^\d{4}-\d{2}-\d{2}$/.test(targetFinishAt))return json({ok:false,error:"Previsão de conclusão inválida"},400);
        const nextStatus=status??existing.status;
        const nextStarted=startedAt!==null?(startedAt||null):existing.started_at;
        let nextFinished=finishedAt!==null?(finishedAt||null):existing.finished_at;
        if(status==="Concluído"&&finishedAt===null&&!nextFinished)nextFinished=new Date().toISOString().slice(0,10);
        if(status==="Lendo"&&finishedAt===null)nextFinished=null;
        const nextTarget=targetFinishAt!==null?(targetFinishAt||null):existing.target_finish_at,nextCompletionId=completionActivityId!==null?(completionActivityId||null):existing.completion_activity_id;
        await env.DB.prepare(`UPDATE family_books SET status=?,started_at=?,target_finish_at=?,finished_at=?,completion_activity_id=?,updated_at=datetime('now') WHERE id=?`)
          .bind(nextStatus,nextStarted,nextTarget,nextFinished,nextCompletionId,id).run();
        return json({ok:true,status:nextStatus,started_at:nextStarted,target_finish_at:nextTarget,finished_at:nextFinished,completion_activity_id:nextCompletionId});
      }

      if(familyBookMatch&&request.method==="DELETE"){
        const id=decodeURIComponent(familyBookMatch[1]),existing=await env.DB.prepare(`SELECT id,family_id,child_id FROM family_books WHERE id=? LIMIT 1`).bind(id).first();
        if(!existing)return json({ok:false,error:"Livro da família não encontrado"},404);
        await requireFamilyMember(user.id,existing.family_id);
        await env.DB.prepare(`DELETE FROM family_books WHERE id=?`).bind(id).run();
        return json({ok:true,deleted_id:id,preserved_catalog:true,preserved_activity_records:true});
      }

      if(url.pathname==="/community-books/pending"&&request.method==="GET"){
        requireGlobalAdmin(user);
        const rs=await env.DB.prepare(`SELECT cb.*,f.name AS family_name FROM community_books cb LEFT JOIN families f ON f.id=cb.requested_by_family_id WHERE cb.status='pending' ORDER BY cb.created_at ASC`).all();
        return json({ok:true,books:(rs.results||[]).map(b=>({...b,authors:JSON.parse(b.authors_json||"[]"),thumbnail:b.cover_url||""}))});
      }

      if(url.pathname==="/community-books/admin-search"&&request.method==="GET"){
        requireGlobalAdmin(user);const q=String(url.searchParams.get("q")||"").trim(),like=`%${q}%`;
        const rs=await env.DB.prepare(`SELECT * FROM community_books WHERE status='approved' AND merged_into_id IS NULL AND (title LIKE ? COLLATE NOCASE OR authors_json LIKE ? COLLATE NOCASE OR isbn13 LIKE ? COLLATE NOCASE) ORDER BY title LIMIT 10`).bind(like,like,like).all();
        return json({ok:true,items:(rs.results||[]).map(b=>({community_book_id:b.id,title:b.title,authors:JSON.parse(b.authors_json||"[]")}))});
      }

      const communityEdit=url.pathname.match(/^\/community-books\/([^/]+)$/);
      if(communityEdit&&request.method==="PUT"){
        requireGlobalAdmin(user);const id=decodeURIComponent(communityEdit[1]),body=await request.json();
        await env.DB.prepare(`UPDATE community_books SET title=?,authors_json=?,publisher=?,isbn13=?,cover_url=?,updated_at=datetime('now') WHERE id=?`)
          .bind(String(body.title||"").trim(),JSON.stringify(body.authors||[]),String(body.publisher||"").trim(),String(body.isbn13||"").replace(/\D/g,""),String(body.thumbnail||"").trim(),id).run();
        return json({ok:true});
      }
      const communityReview=url.pathname.match(/^\/community-books\/([^/]+)\/(approve|reject)$/);
      if(communityReview&&request.method==="POST"){
        requireGlobalAdmin(user);const id=decodeURIComponent(communityReview[1]),status=communityReview[2]==="approve"?"approved":"rejected";
        await env.DB.prepare(`UPDATE community_books SET status=?,reviewed_by_user_id=?,reviewed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(status,user.id,id).run();
        return json({ok:true,status});
      }
      const communityMerge=url.pathname.match(/^\/community-books\/([^/]+)\/merge$/);
      if(communityMerge&&request.method==="POST"){
        requireGlobalAdmin(user);const sourceId=decodeURIComponent(communityMerge[1]),body=await request.json(),targetType=String(body.target_type||"community");
        const source=await env.DB.prepare(`SELECT id FROM community_books WHERE id=? AND status='pending' LIMIT 1`).bind(sourceId).first();
        if(!source)return json({ok:false,error:"Livro pendente não encontrado"},404);
        if(targetType==="google_books"){
          if(!env.GOOGLE_BOOKS_API_KEY)return json({ok:false,error:"GOOGLE_BOOKS_API_KEY não configurada"},500);
          const volumeId=String(body.google_volume_id||"").trim();if(!volumeId)return json({ok:false,error:"Volume do Google Books inválido"},400);
          const endpoint=`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(volumeId)}?key=${encodeURIComponent(env.GOOGLE_BOOKS_API_KEY)}`;
          const gr=await fetch(endpoint,{headers:{"Accept":"application/json"}}),volume=await gr.json().catch(()=>({}));
          if(!gr.ok||!volume?.id)return json({ok:false,error:"Livro não encontrado no Google Books",provider_status:gr.status},404);
          const i=volume.volumeInfo||{},ids=Array.isArray(i.industryIdentifiers)?i.industryIdentifiers:[],isbn13=ids.find(x=>x.type==="ISBN_13")?.identifier||"",isbn10=ids.find(x=>x.type==="ISBN_10")?.identifier||"";let cover=i.imageLinks?.thumbnail||i.imageLinks?.smallThumbnail||"";if(cover)cover=cover.replace(/^http:/,"https:");
          await env.DB.batch([
            env.DB.prepare(`UPDATE family_books SET source='google_books',google_volume_id=?,community_book_id=NULL,title_snapshot=?,authors_json_snapshot=?,publisher_snapshot=?,published_date_snapshot=?,isbn13_snapshot=?,isbn10_snapshot=?,page_count_snapshot=?,categories_json_snapshot=?,language_snapshot=?,description_snapshot=?,cover_url_snapshot=?,updated_at=datetime('now') WHERE community_book_id=?`).bind(volume.id,String(i.title||""),JSON.stringify(i.authors||[]),String(i.publisher||""),String(i.publishedDate||""),isbn13,isbn10,Number.isFinite(Number(i.pageCount))?Number(i.pageCount):null,JSON.stringify(i.categories||[]),String(i.language||""),String(i.description||""),cover,sourceId),
            env.DB.prepare(`UPDATE community_books SET status='merged',merged_into_id=NULL,reviewed_by_user_id=?,reviewed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(user.id,sourceId)
          ]);
          return json({ok:true,target_type:"google_books",google_volume_id:volume.id});
        }
        const targetId=String(body.target_book_id||"").trim();
        if(!targetId||targetId===sourceId)return json({ok:false,error:"Livro canônico inválido"},400);
        const target=await env.DB.prepare(`SELECT id FROM community_books WHERE id=? AND status='approved' LIMIT 1`).bind(targetId).first();
        if(!target)return json({ok:false,error:"Livro canônico não encontrado"},404);
        await env.DB.batch([env.DB.prepare(`UPDATE family_books SET community_book_id=?,updated_at=datetime('now') WHERE community_book_id=?`).bind(targetId,sourceId),env.DB.prepare(`UPDATE community_books SET status='merged',merged_into_id=?,reviewed_by_user_id=?,reviewed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(targetId,user.id,sourceId)]);
        return json({ok:true,target_type:"community",merged_into_id:targetId});
      }


      // GOOGLE PLACES (NEW) - autocomplete protegido pelo Worker
      if(url.pathname==="/places/autocomplete"&&request.method==="POST"){
        if(!env.GOOGLE_PLACES_API_KEY)return json({ok:false,error:"GOOGLE_PLACES_API_KEY não configurada"},500);
        const body=await request.json().catch(()=>({}));
        const input=String(body.input||"").trim();
        const sessionToken=String(body.session_token||"").trim();
        if(input.length<3)return json({ok:true,items:[]});
        const payload={input,languageCode:"pt-BR",regionCode:"BR",includedRegionCodes:["br"]};
        if(sessionToken)payload.sessionToken=sessionToken;
        const r=await fetch("https://places.googleapis.com/v1/places:autocomplete",{
          method:"POST",
          headers:{
            "Content-Type":"application/json",
            "X-Goog-Api-Key":env.GOOGLE_PLACES_API_KEY,
            "X-Goog-FieldMask":"suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text"
          },
          body:JSON.stringify(payload)
        });
        const raw=await r.json().catch(()=>({}));
        if(!r.ok)return json({ok:false,error:"Não foi possível consultar o Google Places",provider_status:r.status,detail:raw?.error?.message||""},502);
        const items=(raw.suggestions||[]).map(s=>s.placePrediction).filter(Boolean).slice(0,6).map(p=>({
          place_id:p.placeId||"",
          text:p.text?.text||"",
          main_text:p.structuredFormat?.mainText?.text||p.text?.text||"",
          secondary_text:p.structuredFormat?.secondaryText?.text||""
        }));
        return json({ok:true,items});
      }

      // GOOGLE PLACES (NEW) - detalhes mínimos após a seleção
      if(url.pathname.startsWith("/places/details/")&&request.method==="GET"){
        if(!env.GOOGLE_PLACES_API_KEY)return json({ok:false,error:"GOOGLE_PLACES_API_KEY não configurada"},500);
        const placeId=decodeURIComponent(url.pathname.slice("/places/details/".length)).trim();
        const sessionToken=String(url.searchParams.get("session_token")||"").trim();
        if(!placeId)return json({ok:false,error:"Place ID obrigatório"},400);
        const endpoint=new URL("https://places.googleapis.com/v1/places/"+encodeURIComponent(placeId));
        endpoint.searchParams.set("languageCode","pt-BR");
        endpoint.searchParams.set("regionCode","BR");
        if(sessionToken)endpoint.searchParams.set("sessionToken",sessionToken);
        const r=await fetch(endpoint.toString(),{
          headers:{
            "Accept":"application/json",
            "X-Goog-Api-Key":env.GOOGLE_PLACES_API_KEY,
            "X-Goog-FieldMask":"id,displayName,formattedAddress,location"
          }
        });
        const raw=await r.json().catch(()=>({}));
        if(!r.ok)return json({ok:false,error:"Não foi possível obter os detalhes do local",provider_status:r.status,detail:raw?.error?.message||""},502);
        return json({ok:true,place:{
          place_id:raw.id||placeId,
          name:raw.displayName?.text||"",
          address:raw.formattedAddress||"",
          latitude:raw.location?.latitude??null,
          longitude:raw.location?.longitude??null
        }});
      }

      // ADMINISTRAÇÃO — CONSUMO DE IA POR FAMÍLIA
      if(url.pathname==="/admin/ai-usage"&&request.method==="GET"){
        requireGlobalAdmin(user);
        const today=new Date().toISOString().slice(0,10);
        const monthStart=today.slice(0,8)+"01";
        const from=/^\d{4}-\d{2}-\d{2}$/.test(String(url.searchParams.get("from")||""))?String(url.searchParams.get("from")):monthStart;
        const to=/^\d{4}-\d{2}-\d{2}$/.test(String(url.searchParams.get("to")||""))?String(url.searchParams.get("to")):today;
        const familyId=String(url.searchParams.get("family_id")||"").trim();
        let where=`u.created_at>=? AND u.created_at<datetime(?,'+1 day')`,params=[from,to];
        if(familyId){where+=` AND u.family_id=?`;params.push(familyId)}
        const familyRows=await env.DB.prepare(`
          SELECT u.family_id,f.name AS family_name,
            COUNT(DISTINCT u.request_id) AS user_requests,
            COUNT(*) AS provider_calls,
            SUM(CASE WHEN u.status='success' THEN 1 ELSE 0 END) AS successful_calls,
            SUM(u.prompt_tokens) AS prompt_tokens,SUM(u.output_tokens) AS output_tokens,
            SUM(u.thoughts_tokens) AS thoughts_tokens,SUM(u.total_tokens) AS total_tokens,
            SUM(u.estimated_input_cost_usd_micros) AS estimated_input_cost_usd_micros,
            SUM(u.estimated_output_cost_usd_micros) AS estimated_output_cost_usd_micros,
            SUM(u.estimated_cost_usd_micros) AS estimated_cost_usd_micros,
            MAX(u.created_at) AS last_used_at
          FROM ai_usage_events u JOIN families f ON f.id=u.family_id
          WHERE ${where}
          GROUP BY u.family_id,f.name ORDER BY total_tokens DESC,f.name
        `).bind(...params).all();
        const featureRows=await env.DB.prepare(`
          SELECT u.family_id,u.feature,COUNT(DISTINCT u.request_id) AS user_requests,COUNT(*) AS provider_calls,
            SUM(u.prompt_tokens) AS prompt_tokens,SUM(u.output_tokens) AS output_tokens,
            SUM(u.thoughts_tokens) AS thoughts_tokens,SUM(u.total_tokens) AS total_tokens,
            SUM(u.estimated_input_cost_usd_micros) AS estimated_input_cost_usd_micros,
            SUM(u.estimated_output_cost_usd_micros) AS estimated_output_cost_usd_micros,
            SUM(u.estimated_cost_usd_micros) AS estimated_cost_usd_micros
          FROM ai_usage_events u WHERE ${where}
          GROUP BY u.family_id,u.feature ORDER BY u.family_id,total_tokens DESC
        `).bind(...params).all();
        const modelRows=await env.DB.prepare(`
          SELECT u.family_id,u.model,u.operation,u.token_count_source,
            COUNT(*) AS provider_calls,SUM(u.prompt_tokens) AS prompt_tokens,SUM(u.output_tokens) AS output_tokens,
            SUM(u.thoughts_tokens) AS thoughts_tokens,SUM(u.total_tokens) AS total_tokens,
            SUM(u.estimated_input_cost_usd_micros) AS estimated_input_cost_usd_micros,
            SUM(u.estimated_output_cost_usd_micros) AS estimated_output_cost_usd_micros,
            SUM(u.estimated_cost_usd_micros) AS estimated_cost_usd_micros
          FROM ai_usage_events u WHERE ${where}
          GROUP BY u.family_id,u.model,u.operation,u.token_count_source ORDER BY u.family_id,u.model,u.operation
        `).bind(...params).all();
        const totals=(familyRows.results||[]).reduce((a,x)=>({families:a.families+1,user_requests:a.user_requests+Number(x.user_requests||0),provider_calls:a.provider_calls+Number(x.provider_calls||0),prompt_tokens:a.prompt_tokens+Number(x.prompt_tokens||0),output_tokens:a.output_tokens+Number(x.output_tokens||0),thoughts_tokens:a.thoughts_tokens+Number(x.thoughts_tokens||0),total_tokens:a.total_tokens+Number(x.total_tokens||0),estimated_input_cost_usd_micros:a.estimated_input_cost_usd_micros+Number(x.estimated_input_cost_usd_micros||0),estimated_output_cost_usd_micros:a.estimated_output_cost_usd_micros+Number(x.estimated_output_cost_usd_micros||0),estimated_cost_usd_micros:a.estimated_cost_usd_micros+Number(x.estimated_cost_usd_micros||0)}),{families:0,user_requests:0,provider_calls:0,prompt_tokens:0,output_tokens:0,thoughts_tokens:0,total_tokens:0,estimated_input_cost_usd_micros:0,estimated_output_cost_usd_micros:0,estimated_cost_usd_micros:0});
        const configuredRates=aiModelRates("gemini-3.5-flash-lite");
        return json({ok:true,from,to,totals,families:familyRows.results||[],features:featureRows.results||[],models:modelRows.results||[],pricing_configured:configuredRates.input>0||configuredRates.output>0,pricing_basis:"paid_standard_projection"});
      }

      // GOOGLE BOOKS - pesquisa pública de volumes
      if(url.pathname==="/books/search"&&request.method==="GET"){
        if(!env.GOOGLE_BOOKS_API_KEY)return json({ok:false,error:"GOOGLE_BOOKS_API_KEY não configurada"},500);
        const q=String(url.searchParams.get("q")||"").trim();
        if(q.length<2)return json({ok:false,error:"Informe pelo menos 2 caracteres"},400);
        const endpoint=new URL("https://www.googleapis.com/books/v1/volumes");
        endpoint.searchParams.set("q",q);
        endpoint.searchParams.set("printType","books");
        endpoint.searchParams.set("orderBy","relevance");
        endpoint.searchParams.set("maxResults","8");
        if(!/^isbn:/i.test(q))endpoint.searchParams.set("langRestrict","pt");
        endpoint.searchParams.set("key",env.GOOGLE_BOOKS_API_KEY);
        const r=await fetch(endpoint.toString(),{headers:{"Accept":"application/json"}});
        const raw=await r.json();
        if(!r.ok)return json({ok:false,error:"Não foi possível consultar o Google Books",provider_status:r.status},502);
        const items=(raw.items||[]).slice(0,8).map(v=>{
          const i=v.volumeInfo||{},ids=Array.isArray(i.industryIdentifiers)?i.industryIdentifiers:[];
          const isbn13=ids.find(x=>x.type==="ISBN_13")?.identifier||"",isbn10=ids.find(x=>x.type==="ISBN_10")?.identifier||"";
          let thumb=i.imageLinks?.thumbnail||i.imageLinks?.smallThumbnail||"";
          if(thumb)thumb=thumb.replace(/^http:/,"https:");
          return {google_volume_id:v.id||"",title:i.title||"",subtitle:i.subtitle||"",authors:i.authors||[],publisher:i.publisher||"",published_date:i.publishedDate||"",description:i.description||"",isbn13,isbn10,page_count:i.pageCount||null,categories:i.categories||[],language:i.language||"",thumbnail:thumb,info_link:i.infoLink||""};
        });
        return json({ok:true,source:"google_books",items});
      }

      // IA - RESUMO DO RELATÓRIO
      if(url.pathname==="/ai/report-summary"&&request.method==="POST"){
        if(!env.GEMINI_API_KEY)return json({ok:false,error:"GEMINI_API_KEY não configurada"},500);
        const body=await request.json(),childId=String(body.child_id||"").trim(),childName=String(body.child_name||"").trim(),referenceStage=String(body.reference_stage||"").trim(),period=String(body.period||"").trim(),activities=Array.isArray(body.activities)?body.activities.slice(0,120):[];
        if(!childId||!activities.length)return json({ok:false,error:"Criança e atividades são obrigatórias"},400);
        const child=await env.DB.prepare(`SELECT id,family_id,active FROM children WHERE id=? LIMIT 1`).bind(childId).first();
        if(!child)return json({ok:false,error:"Criança não encontrada"},404);await requireFamilyMember(user.id,child.family_id);if(!child.active)return json({ok:false,error:"Criança arquivada"},400);
        const aiRequestId=newId("air");
        const lines=activities.map((x,i)=>[`${i+1}. ${String(x.date||"")} | ${String(x.component||"Sem componente")} | ${String(x.status||"Sem avaliação")}`,`Atividade: ${String(x.activity||"").replace(/\s+/g," ").slice(0,500)}`,x.bncc_code?`BNCC: ${String(x.bncc_code)} — ${String(x.bncc_skill||"").replace(/\s+/g," ").slice(0,500)}`:"",x.notes?`Observações: ${String(x.notes).replace(/\s+/g," ").slice(0,350)}`:""].filter(Boolean).join("\n")).join("\n\n");
        const prompt=["Você cria um resumo breve de um relatório familiar de aprendizagem.",`Criança: ${childName||"não informado"}`,referenceStage?`Ano/série de referência: ${referenceStage}`:"",period?`Período: ${period}`:"","REGRAS:","Use SOMENTE fatos presentes nos registros.","Não invente progresso, competências, preferências ou conclusões.","Não faça diagnóstico psicológico, clínico ou pedagógico.","Não compare a criança com outras crianças nem diga que está adiantada ou atrasada.","Não transforme status de avaliação em julgamento geral sobre a criança.","Pode identificar temas, componentes e experiências que aparecem repetidamente.","Mencione BNCC somente quando estiver explicitamente presente.","Escreva em português do Brasil, tom acolhedor e objetivo.","Produza 2 ou 3 parágrafos curtos, sem título, listas ou markdown.","REGISTROS:",lines].filter(Boolean).join("\n");
        const gr=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.2,maxOutputTokens:420}})}),gemini=await gr.json();
        await recordAiUsage({userId:user.id,familyId:child.family_id,childId,requestId:aiRequestId,feature:"report_summary",operation:"generate_summary",model:"gemini-3.5-flash-lite",usage:gemini?.usageMetadata||{},status:gr.ok?"success":"provider_error",providerStatus:gr.status});
        if(!gr.ok)return json({ok:false,error:"Não foi possível gerar o resumo da IA",provider_status:gr.status},502);
        const summary=String(gemini?.candidates?.[0]?.content?.parts?.[0]?.text||"").trim();if(!summary)return json({ok:false,error:"A IA não retornou um resumo"},502);
        return json({ok:true,summary,model:"gemini-3.5-flash-lite"});
      }



      // =========================================================
      // ANÁLISE COMPLETA DA EXPERIÊNCIA — 1 ação no frontend
      // Componentes -> embeddings por componente -> IA escolhe BNCC
      // =========================================================
      if(url.pathname==="/ai/analyze-experience"&&request.method==="POST"){
        if(!env.GEMINI_API_KEY)return json({ok:false,error:"GEMINI_API_KEY não configurada"},500);
        const body=await request.json().catch(()=>({}));
        const childId=String(body.child_id||"").trim(),activity=String(body.activity||"").trim();
        const usageFeature=body.source==="history_batch"?"history_batch_classification":"analyze_experience";
        const planning=body.planning&&typeof body.planning==="object"?body.planning:{};
        if(!childId||activity.length<8)return json({ok:false,error:"Conte um pouco mais sobre o que vocês fizeram ou aprenderam"},400);
        const child=await env.DB.prepare(`SELECT id,family_id,reference_stage,active FROM children WHERE id=? LIMIT 1`).bind(childId).first();
        if(!child)return json({ok:false,error:"Criança não encontrada"},404);
        await requireFamilyMember(user.id,child.family_id);
        if(!child.active)return json({ok:false,error:"Criança arquivada"},400);
        const schoolYear=String(child.reference_stage||"").trim();
        const aiRequestId=newId("air");
        if(!schoolYear)return json({ok:false,error:"Ano/série da criança não está cadastrado"},400);

        const abortFetch=async(url,options={},ms=20000)=>{
          const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),ms);
          try{return await fetch(url,{...options,signal:ctl.signal})}finally{clearTimeout(timer)}
        };
        const geminiJson=async(prompt,schema,maxOutputTokens=220,operation="generate_json")=>{
          let last=null;
          for(let attempt=0;attempt<2;attempt++){
            try{
              const r=await abortFetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",{
                method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
                body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0,maxOutputTokens,responseMimeType:"application/json",responseSchema:schema}})
              },20000);
              const data=await r.json().catch(()=>({}));
              await recordAiUsage({userId:user.id,familyId:child.family_id,childId,requestId:aiRequestId,feature:usageFeature,operation,model:"gemini-3.5-flash-lite",usage:data?.usageMetadata||{},status:r.ok?"success":"provider_error",providerStatus:r.status});
              if(!r.ok){last=new Error(`Gemini ${r.status}`);if(r.status<500&&r.status!==429)break;continue}
              const text=String(data?.candidates?.[0]?.content?.parts?.[0]?.text||"").trim();
              return {value:JSON.parse(text),usage:data?.usageMetadata||{},attempts:attempt+1};
            }catch(e){
              last=e;
              if(e?.name==="AbortError")await recordAiUsage({userId:user.id,familyId:child.family_id,childId,requestId:aiRequestId,feature:usageFeature,operation,model:"gemini-3.5-flash-lite",usage:{},tokenCountSource:"provider",status:"timeout",providerStatus:null});
            }
          }
          const stageLabel=operation==="classify_experience"?"classificação da experiência":operation==="select_bncc"?"seleção de habilidades BNCC":"consulta à IA";
          if(last?.name==="AbortError")throw Object.assign(new Error(`A etapa de ${stageLabel} demorou mais que o esperado`),{code:"AI_STAGE_TIMEOUT",aiStage:operation});
          throw Object.assign(new Error(`Não foi possível concluir a etapa de ${stageLabel}: ${String(last?.message||"falha temporária")}`),{code:"AI_STAGE_ERROR",aiStage:operation,cause:last});
        };
        const norm=v=>String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
        const yearDigits=(schoolYear.match(/\d+/)||[""])[0];
        const addYearScope=(sql,params)=>{
          if(/Ensino Fundamental/i.test(schoolYear)&&yearDigits){
            const y=Number(yearDigits),years=[y-1,y,y+1].filter(n=>n>=1&&n<=9),patterns=years.map(n=>`EF${String(n).padStart(2,"0")}%`);
            if(y<=5)patterns.push("EF15%");if(y>=6)patterns.push("EF69%");if(y===6||y===7)patterns.push("EF67%");if(y===8||y===9)patterns.push("EF89%");
            sql+=` AND (${years.map(()=>"b.school_year LIKE ? COLLATE NOCASE").join(" OR ")} OR ${patterns.map(()=>"b.code LIKE ? COLLATE NOCASE").join(" OR ")})`;
            params.push(...years.map(n=>`%${n}%`),...patterns);return sql;
          }
          if(/Ensino Médio/i.test(schoolYear))return sql+` AND (b.school_year LIKE '%Ensino Médio%' COLLATE NOCASE OR b.code LIKE 'EM13%' COLLATE NOCASE)`;
          if(/Bebês/i.test(schoolYear))return sql+` AND b.code LIKE 'EI01%' COLLATE NOCASE`;
          if(/Crianças bem pequenas/i.test(schoolYear))return sql+` AND b.code LIKE 'EI02%' COLLATE NOCASE`;
          if(/Crianças pequenas/i.test(schoolYear))return sql+` AND b.code LIKE 'EI03%' COLLATE NOCASE`;
          params.push(`%${schoolYear}%`);return sql+` AND b.school_year LIKE ? COLLATE NOCASE`;
        };
        const competencySql=()=>/Ensino Fundamental/i.test(schoolYear)?`(b.code LIKE 'CG%' OR b.code LIKE 'CEF%')`:/Ensino Médio/i.test(schoolYear)?`(b.code LIKE 'CG%' OR b.code LIKE 'CEM%')`:`b.code LIKE 'CG%'`;

        // IA #1: primeiro identifica a natureza da experiência e só depois,
        // quando há evidência explícita, escolhe componentes da lista fechada.
        const cr=await env.DB.prepare(`SELECT DISTINCT curricular_component AS component,knowledge_area AS area FROM bncc_skills WHERE curricular_component IS NOT NULL AND TRIM(curricular_component)<>'' AND code NOT LIKE 'CG%' AND code NOT LIKE 'CEF%' AND code NOT LIKE 'CEM%' ORDER BY curricular_component`).all();
        const options=[],seen=new Set();
        for(const x of (cr.results||[])){const n=String(x.component||"").trim(),k=norm(n);if(n&&!seen.has(k)){seen.add(k);options.push({name:n,area:String(x.area||"").trim()})}}
        const context=[planning.title?`Intenção: ${String(planning.title).slice(0,250)}`:"",planning.notes?`Planejado: ${String(planning.notes).slice(0,400)}`:"",planning.place?`Local: ${String(planning.place).slice(0,180)}`:"",planning.material?`Material: ${String(planning.material).slice(0,180)}`:""].filter(Boolean).join("\n");
        const compPrompt=`Analise SOMENTE o que está explicitamente descrito no RELATO REAL.
Primeiro classifique a experiência como curriculum, complementary ou indeterminate.
Passeios, esportes, visitas, lazer, atividades culturais e experiências cotidianas podem ser atividades complementares.
Uma atividade complementar pode coexistir com componentes curriculares, mas somente quando o relato descreve ações, observações, conhecimentos ou aprendizagens concretas.
NÃO associe componentes apenas por causa do local, objeto ou nome da atividade. Praia não implica automaticamente Ciências ou Geografia; judô não implica automaticamente Educação Física; crochê não implica automaticamente Arte ou Matemática.
O planejamento é contexto secundário e nunca pode criar evidência que não esteja no relato real.
Se não houver evidência curricular suficiente, use evidence_level=insufficient_for_curriculum e retorne components vazio. Não invente aprendizagem e não tente preencher BNCC obrigatoriamente.
Se for complementar, dê um nome curto e natural à atividade em complementary_activity, como “Passeio à praia”. Caso contrário, deixe esse campo vazio.
Ano/série: ${schoolYear}
RELATO REAL: ${activity.slice(0,1800)}
${context?`CONTEXTO:\n${context}`:""}
LISTA FECHADA:
${options.map((x,i)=>`${i+1}. ${x.name} — ${x.area}`).join("\n")}
Retorne somente IDs da lista. relevance serve apenas para ordenação (1-100), não representa certeza.`;
        const compSchema={type:"OBJECT",properties:{experience:{type:"OBJECT",properties:{kind:{type:"STRING",enum:["curriculum","complementary","indeterminate"]},complementary_activity:{type:"STRING"},evidence_level:{type:"STRING",enum:["insufficient_for_curriculum","sufficient","indeterminate"]},reason:{type:"STRING"}},required:["kind","complementary_activity","evidence_level","reason"]},components:{type:"ARRAY",maxItems:3,items:{type:"OBJECT",properties:{id:{type:"INTEGER"},relevance:{type:"INTEGER"}},required:["id","relevance"]}}},required:["experience","components"]};
        const compResult=await geminiJson(compPrompt,compSchema,220,"classify_experience");
        const rawExperience=compResult.value?.experience||{},kind=["curriculum","complementary","indeterminate"].includes(rawExperience.kind)?rawExperience.kind:"indeterminate",evidenceLevel=["insufficient_for_curriculum","sufficient","indeterminate"].includes(rawExperience.evidence_level)?rawExperience.evidence_level:"indeterminate";
        const experience={kind,complementary_activity:kind==="complementary"?String(rawExperience.complementary_activity||"").trim().slice(0,120):"",evidence_level:evidenceLevel,reason:String(rawExperience.reason||"").trim().slice(0,300)};
        const components=[],usedComp=new Set();
        if(experience.evidence_level==="sufficient")for(const c of (compResult.value?.components||[])){const idx=Number(c.id)-1;if(idx>=0&&idx<options.length&&!usedComp.has(idx)){usedComp.add(idx);components.push({component:options[idx].name,area:options[idx].area,relevance:Math.max(1,Math.min(100,Number(c.relevance)||1))})}}
        components.sort((a,b)=>b.relevance-a.relevance);
        if(!components.length)return json({ok:true,experience,components:[],skills:[],competencies:[],message:experience.reason||"Nenhum componente suficientemente relacionado foi encontrado",attempts:{components:compResult.attempts}});

        // Um único embedding do relato, reutilizado em todos os componentes e competências.
        let qvec=null,retrievalMode="embedding";
        try{qvec=await createEmbedding(activity,"query",{familyId:child.family_id,childId,requestId:aiRequestId,feature:usageFeature,operation:"semantic_search"})}catch(e){retrievalMode="textual_fallback"}

        const semanticScores={},skillCandidates=[];
        for(const comp of components){
          let sql=`SELECT b.id,b.code,b.education_stage,b.school_year,b.knowledge_area,b.curricular_component,b.thematic_unit,b.knowledge_object,b.description,e.vector_json FROM bncc_skills b LEFT JOIN bncc_embeddings e ON e.bncc_code=b.code AND e.model=? AND e.dimensions=? WHERE b.code NOT LIKE 'CG%' AND b.code NOT LIKE 'CEF%' AND b.code NOT LIKE 'CEM%'`;
          const params=[EMBEDDING_MODEL,EMBEDDING_DIMENSIONS];sql=addYearScope(sql,params);sql+=` AND b.curricular_component=? COLLATE NOCASE ORDER BY b.code LIMIT 500`;params.push(comp.component);
          const rows=(await env.DB.prepare(sql).bind(...params).all()).results||[];
          let ranked;
          if(qvec){
            ranked=rows.map(s=>{let v=[];try{v=JSON.parse(s.vector_json||"[]")}catch{};return {s,score:cosineSimilarity(qvec,v)}}).sort((a,b)=>b.score-a.score).slice(0,20);
          }else{
            const tokens=[...new Set(norm(activity).split(/\s+/).filter(t=>t.length>=3))].slice(0,30);
            ranked=rows.map(s=>{const hay=norm([s.description,s.knowledge_object,s.thematic_unit].join(" "));return {s,score:tokens.reduce((n,t)=>n+(hay.includes(t)?1:0),0)}}).sort((a,b)=>b.score-a.score).slice(0,20);
          }
          for(const x of ranked){if(qvec)semanticScores[x.s.code]=Number(x.score.toFixed(4));const {vector_json,...clean}=x.s;skillCandidates.push({...clean,_component:comp.component})}
        }

        let csql=`SELECT b.id,b.code,b.education_stage,b.school_year,b.knowledge_area,b.curricular_component,b.thematic_unit,b.knowledge_object,b.description,e.vector_json FROM bncc_skills b LEFT JOIN bncc_embeddings e ON e.bncc_code=b.code AND e.model=? AND e.dimensions=? WHERE ${competencySql()} ORDER BY b.code`;
        const compRows=(await env.DB.prepare(csql).bind(EMBEDDING_MODEL,EMBEDDING_DIMENSIONS).all()).results||[];
        let competencyCandidates;
        if(qvec)competencyCandidates=compRows.map(s=>{let v=[];try{v=JSON.parse(s.vector_json||"[]")}catch{};return {s,score:cosineSimilarity(qvec,v)}}).sort((a,b)=>b.score-a.score).slice(0,10);
        else{const tokens=[...new Set(norm(activity).split(/\s+/).filter(t=>t.length>=3))].slice(0,30);competencyCandidates=compRows.map(s=>({s,score:tokens.reduce((n,t)=>n+(norm(s.description).includes(t)?1:0),0)})).sort((a,b)=>b.score-a.score).slice(0,10)}
        const cleanCompetencies=competencyCandidates.map(x=>{if(qvec)semanticScores[x.s.code]=Number(x.score.toFixed(4));const {vector_json,...clean}=x.s;return clean});

        // IA #2 recebe SOMENTE candidatos fornecidos pelo Worker.
        const skillLines=skillCandidates.map((s,i)=>`H${i+1}|${s.code}|${s.curricular_component}|${s.school_year||""}|${String(s.description||"").replace(/\s+/g," ").slice(0,300)}`);
        const competencyLines=cleanCompetencies.map((s,i)=>`C${i+1}|${s.code}|${s.curricular_component||s.knowledge_area||""}|${String(s.description||"").replace(/\s+/g," ").slice(0,300)}`);
        const selectPrompt=`Selecione apenas aprendizagens REALMENTE EVIDENCIADAS no relato. Não invente códigos. Use somente IDs candidatos abaixo.
Ano/série: ${schoolYear}
RELATO: ${activity.slice(0,1600)}
Componentes identificados: ${components.map(x=>x.component).join(", ")}
HABILIDADES:
${skillLines.join("\n")}
COMPETÊNCIAS:
${competencyLines.join("\n")}
Escolha até 6 habilidades no total. Tente contemplar cada componente genuinamente relevante, mas nunca force habilidade fraca. Escolha até 3 competências claramente relacionadas.`;
        const selectSchema={type:"OBJECT",properties:{skills:{type:"ARRAY",maxItems:6,items:{type:"STRING"}},competencies:{type:"ARRAY",maxItems:3,items:{type:"STRING"}}},required:["skills","competencies"]};
        const selected=await geminiJson(selectPrompt,selectSchema,180,"select_bncc");
        const parseIds=(arr,prefix,max)=>[...new Set((Array.isArray(arr)?arr:[]).map(x=>String(x).trim().toUpperCase()).filter(x=>new RegExp(`^${prefix}\\d+$`).test(x)).map(x=>Number(x.slice(1))).filter(n=>n>=1&&n<=max))];
        const hi=parseIds(selected.value?.skills,"H",skillCandidates.length),ci=parseIds(selected.value?.competencies,"C",cleanCompetencies.length);
        const skills=hi.map((n,i)=>({rank:i+1,semantic_similarity:semanticScores[skillCandidates[n-1].code]??null,...skillCandidates[n-1]}));
        const competencies=ci.map((n,i)=>({rank:i+1,semantic_similarity:semanticScores[cleanCompetencies[n-1].code]??null,...cleanCompetencies[n-1]}));
        return json({ok:true,experience,components,skills,competencies,retrieval_mode:retrievalMode,models:{classifier:"gemini-3.5-flash-lite",embedding:qvec?EMBEDDING_MODEL:null,selector:"gemini-3.5-flash-lite"},attempts:{components:compResult.attempts,bncc:selected.attempts}});
      }

      // =========================================================
      // IA #1 - CLASSIFICAÇÃO DE COMPONENTES DA EXPERIÊNCIA
      // O relato real tem prioridade sobre o planejamento.
      // =========================================================
      if(url.pathname==="/ai/components-classify"&&request.method==="POST"){
        if(!env.GEMINI_API_KEY)return json({ok:false,error:"GEMINI_API_KEY não configurada"},500);
        const body=await request.json().catch(()=>({}));
        const childId=String(body.child_id||"").trim();
        const activity=String(body.activity||"").trim();
        const planning=body.planning&&typeof body.planning==="object"?body.planning:{};
        if(!childId||!activity)return json({ok:false,error:"child_id e activity são obrigatórios"},400);
        if(activity.length<8)return json({ok:false,error:"Descreva um pouco mais o que realmente aconteceu"},400);

        const child=await env.DB.prepare(`SELECT id,family_id,reference_stage,active FROM children WHERE id=? LIMIT 1`).bind(childId).first();
        if(!child)return json({ok:false,error:"Criança não encontrada"},404);
        await requireFamilyMember(user.id,child.family_id);
        if(!child.active)return json({ok:false,error:"Criança arquivada"},400);

        const compRows=await env.DB.prepare(`
          SELECT DISTINCT curricular_component AS component, knowledge_area AS area
          FROM bncc_skills
          WHERE curricular_component IS NOT NULL
            AND TRIM(curricular_component)<>''
            AND code NOT LIKE 'CG%'
            AND code NOT LIKE 'CEF%'
            AND code NOT LIKE 'CEM%'
          ORDER BY curricular_component
        `).all();

        const options=[];
        const seen=new Set();
        for(const row of (compRows.results||[])){
          const name=String(row.component||"").trim();
          if(!name||seen.has(name.toLocaleLowerCase("pt-BR")))continue;
          seen.add(name.toLocaleLowerCase("pt-BR"));
          options.push({name,area:String(row.area||"").trim()});
        }
        if(!options.length)return json({ok:false,error:"Não foi possível carregar os componentes da BNCC"},500);

        const indexed=options.map((x,i)=>`${i+1}. ${x.name}${x.area?` — ${x.area}`:""}`).join("\n");
        const planningLines=[
          planning.title?`Intenção original: ${String(planning.title).slice(0,300)}`:"",
          planning.notes?`Como estava planejado: ${String(planning.notes).slice(0,500)}`:"",
          planning.place?`Local planejado: ${String(planning.place).slice(0,220)}`:"",
          planning.material?`Material planejado: ${String(planning.material).slice(0,220)}`:""
        ].filter(Boolean).join("\n");

        const prompt=`Você classifica uma experiência educacional brasileira por COMPONENTES CURRICULARES.
A criança está em: ${String(child.reference_stage||"Sem ano informado")}.

REGRA MAIS IMPORTANTE:
O relato do que REALMENTE ACONTECEU tem prioridade absoluta. O planejamento é apenas contexto e nunca deve substituir ou contradizer o relato real.

RELATO REAL:
${activity.slice(0,1800)}

${planningLines?`CONTEXTO DO PLANEJAMENTO (peso menor):\n${planningLines}\n`:""}
COMPONENTES PERMITIDOS:
${indexed}

Escolha de 1 a no máximo 3 componentes realmente evidenciados no relato.
Não invente componentes fora da lista.
Não force um terceiro componente se a relação for fraca.
Para cada escolhido, dê uma relevância estimada inteira de 1 a 100, apenas para ordenar a análise; isso NÃO representa certeza, precisão nem similaridade semântica.

Responda SOMENTE neste formato:
numero:relevancia,numero:relevancia
Exemplo: 5:92,2:71
Sem explicações.`;

        const gr=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",{
          method:"POST",
          headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
          body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0,maxOutputTokens:70}})
        });
        const gemini=await gr.json().catch(()=>({}));
        if(!gr.ok)return json({ok:false,error:"Não foi possível analisar os componentes",provider_status:gr.status},502);

        const answer=String(gemini?.candidates?.[0]?.content?.parts?.[0]?.text||"").trim();
        const found=[];
        const used=new Set();
        for(const m of answer.matchAll(/(\d+)\s*:\s*(\d{1,3})/g)){
          const idx=Number(m[1])-1,rel=Math.max(1,Math.min(100,Number(m[2])));
          if(idx<0||idx>=options.length||used.has(idx))continue;
          used.add(idx);
          found.push({component:options[idx].name,area:options[idx].area,relevance:rel});
          if(found.length>=3)break;
        }
        found.sort((a,b)=>b.relevance-a.relevance);
        return json({
          ok:true,
          components:found,
          model:"gemini-3.5-flash-lite",
          rule:"actual_experience_over_planning",
          usage:{
            prompt_tokens:gemini?.usageMetadata?.promptTokenCount||0,
            output_tokens:gemini?.usageMetadata?.candidatesTokenCount||0,
            total_tokens:gemini?.usageMetadata?.totalTokenCount||0
          }
        });
      }

      // =========================================================
      // IA - SUGESTÃO BNCC: 20 habilidades (ano anterior + referência + próximo) + 10 competências -> 1 Gemini
      // =========================================================
      if(url.pathname==="/ai/bncc-suggest"&&request.method==="POST"){
        if(!env.GEMINI_API_KEY)return json({ok:false,error:"GEMINI_API_KEY não configurada"},500);
        const body=await request.json();
        const childId=String(body.child_id||"").trim();
        const activity=String(body.activity||"").trim();
        const component=String(body.component||"").trim();
        const area=String(body.area||"").trim();
        if(!childId||!activity)return json({ok:false,error:"child_id e activity são obrigatórios"},400);
        if(activity.length<5)return json({ok:false,error:"Descreva um pouco mais a atividade"},400);

        const child=await env.DB.prepare(`SELECT id,family_id,reference_stage,active FROM children WHERE id=? LIMIT 1`).bind(childId).first();
        if(!child)return json({ok:false,error:"Criança não encontrada"},404);
        await requireFamilyMember(user.id,child.family_id);
        if(!child.active)return json({ok:false,error:"Criança arquivada"},400);
        const schoolYear=String(child.reference_stage||"").trim();
        if(!schoolYear)return json({ok:false,error:"Ano/série da criança não está cadastrado"},400);

        function norm(v){return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
        const yearDigits=(schoolYear.match(/\d+/)||[""])[0];
        function addYearScope(sql,params,nearby=false){
          if(/Ensino Fundamental/i.test(schoolYear)&&yearDigits){
            const y=Number(yearDigits), years=nearby?[y-1,y,y+1].filter(n=>n>=1&&n<=9):[y];
            const patterns=[];
            for(const n of years)patterns.push(`EF${String(n).padStart(2,"0")}%`);
            if(y>=1&&y<=5)patterns.push("EF15%");
            if(y>=6&&y<=9)patterns.push("EF69%");
            if(y===6||y===7)patterns.push("EF67%");
            if(y===8||y===9)patterns.push("EF89%");
            sql+=` AND (${years.map(()=>"b.school_year LIKE ? COLLATE NOCASE").join(" OR ")} OR ${patterns.map(()=>"b.code LIKE ? COLLATE NOCASE").join(" OR ")})`;
            params.push(...years.map(n=>`%${n}%`),...patterns); return sql;
          }
          if(/Ensino Médio/i.test(schoolYear))return sql+` AND (b.school_year LIKE '%Ensino Médio%' COLLATE NOCASE OR b.code LIKE 'EM13%' COLLATE NOCASE)`;
          if(/Bebês/i.test(schoolYear))return sql+` AND b.code LIKE 'EI01%' COLLATE NOCASE`;
          if(/Crianças bem pequenas/i.test(schoolYear))return sql+` AND b.code LIKE 'EI02%' COLLATE NOCASE`;
          if(/Crianças pequenas/i.test(schoolYear))return sql+` AND b.code LIKE 'EI03%' COLLATE NOCASE`;
          params.push(`%${schoolYear}%`); return sql+` AND b.school_year LIKE ? COLLATE NOCASE`;
        }

        function competencyPrefixSql(){
          // CG = competências gerais/transversais.
          // CEF = competências específicas do Ensino Fundamental.
          // CEM = competências específicas do Ensino Médio.
          if(/Ensino Fundamental/i.test(schoolYear))return `(b.code LIKE 'CG%' OR b.code LIKE 'CEF%')`;
          if(/Ensino Médio/i.test(schoolYear))return `(b.code LIKE 'CG%' OR b.code LIKE 'CEM%')`;
          return `b.code LIKE 'CG%'`;
        }

        async function loadSemanticPool(nearby=false){
          let sql=`SELECT b.id,b.code,b.education_stage,b.school_year,b.knowledge_area,b.curricular_component,b.thematic_unit,b.knowledge_object,b.covers_multiple_years,b.description,e.vector_json FROM bncc_skills b JOIN bncc_embeddings e ON e.bncc_code=b.code AND e.model=? AND e.dimensions=? WHERE b.code NOT LIKE 'CG%' AND b.code NOT LIKE 'CEF%' AND b.code NOT LIKE 'CEM%'`;
          const params=[EMBEDDING_MODEL,EMBEDDING_DIMENSIONS];
          sql=addYearScope(sql,params,nearby);
          if(component){sql+=` AND b.curricular_component=? COLLATE NOCASE`;params.push(component);}
          if(area){sql+=` AND b.knowledge_area=? COLLATE NOCASE`;params.push(area);}
          sql+=` ORDER BY b.code LIMIT 700`;
          let r=await env.DB.prepare(sql).bind(...params).all();
          if(r.results.length<12&&(component||area)){
            let s2=`SELECT b.id,b.code,b.education_stage,b.school_year,b.knowledge_area,b.curricular_component,b.thematic_unit,b.knowledge_object,b.covers_multiple_years,b.description,e.vector_json FROM bncc_skills b JOIN bncc_embeddings e ON e.bncc_code=b.code AND e.model=? AND e.dimensions=? WHERE b.code NOT LIKE 'CG%' AND b.code NOT LIKE 'CEF%' AND b.code NOT LIKE 'CEM%'`;
            const p2=[EMBEDDING_MODEL,EMBEDDING_DIMENSIONS]; s2=addYearScope(s2,p2,nearby); s2+=` ORDER BY b.code LIMIT 700`;
            r=await env.DB.prepare(s2).bind(...p2).all();
          }
          return r.results;
        }

        async function loadSemanticCompetencyPool(){
          const sql=`SELECT b.id,b.code,b.education_stage,b.school_year,b.knowledge_area,b.curricular_component,b.thematic_unit,b.knowledge_object,b.covers_multiple_years,b.description,e.vector_json FROM bncc_skills b JOIN bncc_embeddings e ON e.bncc_code=b.code AND e.model=? AND e.dimensions=? WHERE ${competencyPrefixSql()} ORDER BY b.code`;
          const r=await env.DB.prepare(sql).bind(EMBEDDING_MODEL,EMBEDDING_DIMENSIONS).all();
          return r.results;
        }

        function textualScore(skill,tokens){
          const hay=norm([skill.description,skill.knowledge_object,skill.thematic_unit,skill.curricular_component,skill.knowledge_area].join(" "));
          let score=tokens.reduce((n,t)=>n+(hay.includes(t)?1:0),0);
          if(component&&norm(skill.curricular_component)===norm(component))score+=4;
          if(area&&norm(skill.knowledge_area)===norm(area))score+=3;
          return score;
        }

        async function loadTextualCandidates(){
          let sql=`SELECT id,code,education_stage,school_year,knowledge_area,curricular_component,thematic_unit,knowledge_object,covers_multiple_years,description FROM bncc_skills b WHERE b.code NOT LIKE 'CG%' AND b.code NOT LIKE 'CEF%' AND b.code NOT LIKE 'CEM%'`;
          const params=[]; sql=addYearScope(sql,params,true);
          if(component){sql+=` AND curricular_component=? COLLATE NOCASE`;params.push(component);}
          if(area){sql+=` AND knowledge_area=? COLLATE NOCASE`;params.push(area);}
          sql+=` ORDER BY code LIMIT 300`;
          const r=await env.DB.prepare(sql).bind(...params).all();
          const tokens=[...new Set(norm(activity).split(/\s+/).filter(t=>t.length>=3))].slice(0,25);
          return r.results.map(skill=>({skill,score:textualScore(skill,tokens)})).sort((a,b)=>b.score-a.score).slice(0,20).map(x=>x.skill);
        }

        async function loadTextualCompetencies(){
          const sql=`SELECT id,code,education_stage,school_year,knowledge_area,curricular_component,thematic_unit,knowledge_object,covers_multiple_years,description FROM bncc_skills b WHERE ${competencyPrefixSql()} ORDER BY code`;
          const r=await env.DB.prepare(sql).all();
          const tokens=[...new Set(norm(activity).split(/\s+/).filter(t=>t.length>=3))].slice(0,25);
          return r.results.map(skill=>({skill,score:textualScore(skill,tokens)})).sort((a,b)=>b.score-a.score).slice(0,10).map(x=>x.skill);
        }

        let retrievalMode="embedding", semanticScores={}, embeddingFallbackReason="";
        let pool=[], competencyPool=[];
        try{
          [pool,competencyPool]=await Promise.all([loadSemanticPool(true),loadSemanticCompetencyPool()]);
        }catch(e){
          embeddingFallbackReason=e.message||"índice indisponível";
          console.warn("Embedding table unavailable; textual fallback",embeddingFallbackReason);
        }

        let candidates=[], competencyCandidates=[];
        if(pool.length||competencyPool.length){
          try{
            // Um único embedding da atividade é reutilizado nas duas buscas.
            const qvec=await createEmbedding(activity,"query");
            let ranked=pool.map(skill=>{let v=[];try{v=JSON.parse(skill.vector_json||"[]")}catch{};const similarity=cosineSimilarity(qvec,v);return {skill,similarity};}).sort((a,b)=>b.similarity-a.similarity);
            if((!ranked.length||ranked[0].similarity<0.42)&&/Ensino Fundamental/i.test(schoolYear)){
              const expanded=await loadSemanticPool(true);
              ranked=expanded.map(skill=>{let v=[];try{v=JSON.parse(skill.vector_json||"[]")}catch{};return {skill,similarity:cosineSimilarity(qvec,v)};}).sort((a,b)=>b.similarity-a.similarity);
            }
            candidates=ranked.slice(0,20).map(x=>{semanticScores[x.skill.code]=Number(x.similarity.toFixed(4));const {vector_json,...skill}=x.skill;return skill;});

            const competencyRanked=competencyPool.map(skill=>{let v=[];try{v=JSON.parse(skill.vector_json||"[]")}catch{};return {skill,similarity:cosineSimilarity(qvec,v)};}).sort((a,b)=>b.similarity-a.similarity);
            competencyCandidates=competencyRanked.slice(0,10).map(x=>{semanticScores[x.skill.code]=Number(x.similarity.toFixed(4));const {vector_json,...skill}=x.skill;return skill;});
          }catch(e){
            retrievalMode="textual_fallback";
            embeddingFallbackReason=e.message||"falha ao gerar embedding";
            console.warn("Query embedding failed; using textual fallback",embeddingFallbackReason);
            [candidates,competencyCandidates]=await Promise.all([loadTextualCandidates(),loadTextualCompetencies()]);
          }
        }else{
          retrievalMode="textual_fallback";
          if(!embeddingFallbackReason)embeddingFallbackReason="índice semântico indisponível ou ainda incompleto";
          [candidates,competencyCandidates]=await Promise.all([loadTextualCandidates(),loadTextualCompetencies()]);
        }

        if(!candidates.length&&!competencyCandidates.length)return json({ok:true,suggestions:[],competencies:[],candidate_count:0,competency_candidate_count:0,retrieval_mode:retrievalMode,message:"Nenhuma habilidade ou competência BNCC candidata foi encontrada"});

        const skillLines=candidates.map((s,i)=>`H${i+1}|${s.code}|${s.school_year||""}|${s.curricular_component||""}|${String(s.description||"").replace(/\s+/g," ").slice(0,320)}`);
        const competencyLines=competencyCandidates.map((s,i)=>`C${i+1}|${s.code}|${s.curricular_component||""}|${s.knowledge_area||""}|${String(s.description||"").replace(/\s+/g," ").slice(0,320)}`);
        const prompt=[
          `Ano:${schoolYear}`,
          component?`Componente:${component}`:"",
          area?`Área:${area}`:"",
          `Atividade:${activity.slice(0,900)}`,
          retrievalMode==="embedding"?"Os candidatos abaixo já foram recuperados por proximidade semântica.":"Os candidatos abaixo foram recuperados pelo mecanismo textual de contingência.",
          "HABILIDADES CANDIDATAS (compatíveis com a série):",
          skillLines.join("\n"),
          "COMPETÊNCIAS CANDIDATAS (gerais/específicas, sem série):",
          competencyLines.join("\n"),
          "Escolha até 4 HABILIDADES que melhor representam a aprendizagem realmente observada. Pode escolher menos que 4, ou nenhuma, se não houver boa correspondência.",
          "Escolha até 2 COMPETÊNCIAS relacionadas à atividade, somente quando houver relação clara. Pode escolher nenhuma.",
          "Competências são complementares e não substituem as habilidades.",
          "A primeira habilidade deve ser a correspondência MAIS FORTE.",
          "Não invente códigos e use somente os candidatos fornecidos.",
          "Responda APENAS em duas linhas, usando os números dos candidatos. Exemplo:",
          "H: 7,2,11",
          "C: 3"
        ].filter(Boolean).join("\n");

        const gr=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0,maxOutputTokens:48}})});
        const gemini=await gr.json();
        if(!gr.ok)return json({ok:false,error:"Não foi possível obter sugestões da IA",provider_status:gr.status},502);
        const answer=String(gemini?.candidates?.[0]?.content?.parts?.[0]?.text||"").trim();

        function parseIndexes(label,max,maxItems){
          const match=answer.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([^\\n\\r]*)`,"i"));
          if(!match)return [];
          return [...new Set((match[1].match(/\d+/g)||[]).map(Number).filter(n=>Number.isInteger(n)&&n>=1&&n<=max))].slice(0,maxItems);
        }

        const skillIndexes=parseIndexes("H",candidates.length,4);
        const competencyIndexes=parseIndexes("C",competencyCandidates.length,2);
        const suggestions=skillIndexes.map((n,pos)=>({rank:pos+1,strongest:pos===0,semantic_similarity:semanticScores[candidates[n-1].code]??null,...candidates[n-1]}));
        const competencies=competencyIndexes.map((n,pos)=>({rank:pos+1,semantic_similarity:semanticScores[competencyCandidates[n-1].code]??null,...competencyCandidates[n-1]}));
        const usage=gemini?.usageMetadata||{};
        return json({
          ok:true,
          model:"gemini-3.5-flash-lite",
          embedding_model:retrievalMode==="embedding"?EMBEDDING_MODEL:null,
          embedding_dimensions:retrievalMode==="embedding"?EMBEDDING_DIMENSIONS:null,
          retrieval_mode:retrievalMode,
          fallback_reason:retrievalMode==="textual_fallback"?embeddingFallbackReason:null,
          school_year:schoolYear,year_scope:/Ensino Fundamental/i.test(schoolYear)?"ano anterior + referência + próximo":"etapa de referência",
          candidate_count:candidates.length,
          competency_candidate_count:competencyCandidates.length,
          suggestions,
          competencies,
          usage:{prompt_tokens:usage.promptTokenCount??null,output_tokens:usage.candidatesTokenCount??null,total_tokens:usage.totalTokenCount??null,thoughts_tokens:usage.thoughtsTokenCount??null}
        });
      }

      // =========================================================
      // MATERIAIS — CATÁLOGO COMPARTILHADO (v5.18; BNCC do material adormecida)
      // =========================================================

      if (
        url.pathname === "/materials" &&
        request.method === "GET"
      ) {
        const q = String(url.searchParams.get("q") || "").trim();
        const familyId = String(url.searchParams.get("family_id") || "").trim();

        if (familyId) {
          await requireFamilyMember(user.id, familyId);
        }

        let sql = `
          SELECT
            m.id,
            m.name,
            m.publisher,
            m.age_range,
            m.status,
            m.requested_by_family_id,
            m.created_at
          FROM materials m
          WHERE (
            m.status = 'approved'
            ${familyId ? "OR (m.status IN ('pending','rejected') AND m.requested_by_family_id = ?)" : ""}
          )
        `;
        const params = familyId ? [familyId] : [];

        if (q) {
          sql += ` AND m.name LIKE ? COLLATE NOCASE `;
          params.push(`%${q}%`);
        }

        sql += ` ORDER BY m.name LIMIT 20 `;

        const result = await env.DB.prepare(sql).bind(...params).all();

        const materials = result.results || [];

        let links = [];
        if (materials.length) {
          const ids = materials.map(m => m.id);
          const placeholders = ids.map(() => "?").join(",");

          const linkResult = await env.DB
            .prepare(`
              SELECT material_id, bncc_code
              FROM material_bncc_links
              WHERE material_id IN (${placeholders})
            `)
            .bind(...ids)
            .all();

          links = linkResult.results || [];
        }

        const withCodes = materials.map(m => ({
          ...m,
          bncc_codes: links
            .filter(l => l.material_id === m.id)
            .map(l => l.bncc_code)
        }));

        return json({ ok: true, materials: withCodes });
      }

      if (
        url.pathname === "/materials" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const familyId = String(body.family_id || "").trim();
        const name = String(body.name || "").trim();
        const publisher = String(body.publisher || "").trim();
        const ageRange = String(body.age_range || "").trim();
        const contentDescription = String(body.content_description || "").trim();
        // v5.18: material não recebe BNCC no cadastro. Estrutura antiga permanece no banco para compatibilidade.
        const bnccCodes = [];

        if (!familyId || !name) {
          return json(
            { ok: false, error: "family_id e name são obrigatórios" },
            400
          );
        }

        await requireFamilyMember(user.id, familyId);

        const materialId = newId("mat");

        await env.DB
          .prepare(`
            INSERT INTO materials
            (id, name, publisher, age_range, content_description, status, requested_by_family_id)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
          `)
          .bind(materialId, name, publisher || null, ageRange || null, contentDescription || null, familyId)
          .run();

        for (const code of bnccCodes) {
          await env.DB
            .prepare(`
              INSERT INTO material_bncc_links (id, material_id, bncc_code)
              VALUES (?, ?, ?)
            `)
            .bind(newId("mbl"), materialId, code)
            .run();
        }

        return json({
          ok: true,
          material: {
            id: materialId,
            name,
            publisher,
            age_range: ageRange,
            status: "pending",
            requested_by_family_id: familyId,
            bncc_codes: bnccCodes
          },
          message: "Material enviado para validação. Já está disponível para a sua família."
        });
      }

      if (
        url.pathname === "/materials/pending" &&
        request.method === "GET"
      ) {
        requireGlobalAdmin(user);

        const result = await env.DB
          .prepare(`
            SELECT
              m.id, m.name, m.publisher, m.age_range, m.content_description,
              m.created_at, m.requested_by_family_id, f.name AS family_name
            FROM materials m
            LEFT JOIN families f ON f.id = m.requested_by_family_id
            WHERE m.status = 'pending'
            ORDER BY m.created_at ASC
          `)
          .all();

        const pending = result.results || [];

        let links = [];
        if (pending.length) {
          const ids = pending.map(m => m.id);
          const placeholders = ids.map(() => "?").join(",");
          const linkResult = await env.DB
            .prepare(`
              SELECT material_id, bncc_code
              FROM material_bncc_links
              WHERE material_id IN (${placeholders})
            `)
            .bind(...ids)
            .all();
          links = linkResult.results || [];
        }

        return json({
          ok: true,
          materials: pending.map(m => ({
            ...m,
            bncc_codes: links.filter(l => l.material_id === m.id).map(l => l.bncc_code)
          }))
        });
      }

      const materialEditMatch = url.pathname.match(/^\/materials\/([^/]+)$/);
      if (materialEditMatch && request.method === "PUT") {
        requireGlobalAdmin(user);
        const materialId = decodeURIComponent(materialEditMatch[1]);
        const body = await request.json().catch(()=>({}));
        const name = String(body.name || "").trim();
        const publisher = String(body.publisher || "").trim();
        const ageRange = String(body.age_range || "").trim();
        const contentDescription = String(body.content_description || "").trim();
        if (!name) return json({ok:false,error:"Nome do material é obrigatório"},400);
        const existing = await env.DB.prepare(`SELECT id FROM materials WHERE id=? LIMIT 1`).bind(materialId).first();
        if(!existing) return json({ok:false,error:"Material não encontrado"},404);
        await env.DB.prepare(`UPDATE materials SET name=?, publisher=?, age_range=?, content_description=? WHERE id=?`)
          .bind(name,publisher||null,ageRange||null,contentDescription||null,materialId).run();
        return json({ok:true,id:materialId,name,publisher,age_range:ageRange,content_description:contentDescription});
      }

      const materialApproveMatch = url.pathname.match(/^\/materials\/([^/]+)\/approve$/);
      if (materialApproveMatch && request.method === "POST") {
        requireGlobalAdmin(user);

        const materialId = decodeURIComponent(materialApproveMatch[1]);

        await env.DB
          .prepare(`
            UPDATE materials
            SET status = 'approved', approved_at = datetime('now')
            WHERE id = ?
          `)
          .bind(materialId)
          .run();

        return json({ ok: true, id: materialId, status: "approved" });
      }

      const materialRejectMatch = url.pathname.match(/^\/materials\/([^/]+)\/reject$/);
      if (materialRejectMatch && request.method === "POST") {
        requireGlobalAdmin(user);

        const materialId = decodeURIComponent(materialRejectMatch[1]);

        await env.DB
          .prepare(`
            UPDATE materials
            SET status = 'rejected'
            WHERE id = ?
          `)
          .bind(materialId)
          .run();

        return json({ ok: true, id: materialId, status: "rejected" });
      }

      if (
        url.pathname === "/ai/material-bncc-suggest" &&
        request.method === "POST"
      ) {
        if (!env.GEMINI_API_KEY) {
          return json({ ok: false, error: "GEMINI_API_KEY não configurada" }, 500);
        }

        const body = await request.json();

        const contentDescription = String(body.content_description || "").trim();
        const component = String(body.component || "").trim();
        const area = String(body.area || "").trim();
        const ageRange = String(body.age_range || "").trim();

        if (!contentDescription || contentDescription.length < 5) {
          return json(
            { ok: false, error: "Descreva um pouco melhor o que o material ensina" },
            400
          );
        }

        function normalizeText(value) {
          return String(value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
        }

        const stopWords = new Set([
          "a","as","o","os","e","de","da","das","do","dos",
          "em","no","na","nos","nas","um","uma","uns","umas",
          "para","por","com","sem","que","se","ao","aos","à",
          "às","foi","ser","sobre","atividade","material","licao","aula"
        ]);

        const tokens = [
          ...new Set(
            normalizeText(contentDescription)
              .split(/\s+/)
              .filter(t => t.length >= 3 && !stopWords.has(t))
          )
        ].slice(0, 20);

        let sql = `
          SELECT
            id, code, education_stage, school_year, knowledge_area,
            curricular_component, thematic_unit, knowledge_object,
            covers_multiple_years, description
          FROM bncc_skills
          WHERE 1 = 1
        `;
        const params = [];

        if (component) {
          sql += ` AND curricular_component = ? COLLATE NOCASE `;
          params.push(component);
        }
        if (area) {
          sql += ` AND knowledge_area = ? COLLATE NOCASE `;
          params.push(area);
        }
        // A faixa digitada pelo usuário é texto livre (ex.: "2 ano", "2º ano",
        // "3º ao 5º ano"). Não compare o texto inteiro com school_year, pois isso
        // fazia uma entrada como "2 ano" eliminar "2º ano" e zerar os candidatos.
        // Quando houver um único ano, usamos apenas o número como filtro amplo.
        // Para faixas com mais de um ano, deixamos a série para o ranking/IA em vez
        // de excluir habilidades válidas antes da análise.
        const ageYears = [...new Set(ageRange.match(/\d+/g) || [])];
        if (ageYears.length === 1) {
          sql += ` AND school_year LIKE ? COLLATE NOCASE `;
          params.push(`%${ageYears[0]}%`);
        }

        sql += ` ORDER BY code LIMIT 900 `;

        const result = await env.DB.prepare(sql).bind(...params).all();

        function scoreSkill(skill) {
          const haystack = normalizeText([
            skill.description, skill.knowledge_object,
            skill.thematic_unit, skill.curricular_component, skill.knowledge_area
          ].join(" "));

          let score = 0;
          for (const token of tokens) {
            if (haystack.includes(token)) score += token.length >= 7 ? 4 : 2;
          }
          if (component && normalizeText(skill.curricular_component) === normalizeText(component)) score += 8;
          if (area && normalizeText(skill.knowledge_area) === normalizeText(area)) score += 5;
          return score;
        }

        const ranked = result.results
          .map(skill => ({ skill, score: scoreSkill(skill) }))
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score || String(a.skill.code).localeCompare(String(b.skill.code)));

        // Materiais costumam cobrir mais de uma habilidade, então o
        // candidato é um pouco mais generoso que na sugestão de registro diário.
        const candidates = ranked.slice(0, 20).map(item => item.skill);

        if (!candidates.length) {
          return json({
            ok: true,
            suggestions: [],
            candidate_count: 0,
            message: "Nenhuma habilidade BNCC correspondente foi encontrada — isso pode ser normal para conteúdo fora do escopo da BNCC (ex.: idiomas clássicos, lógica formal)."
          });
        }

        const candidateLines = candidates.map((skill, index) => {
          const description = String(skill.description || "").replace(/\s+/g, " ").trim().slice(0, 260);
          return `${index + 1}|${skill.code}|${skill.curricular_component || ""}|${description}`;
        });

        const prompt = [
          ageRange ? `Faixa etária do material:${ageRange}` : "",
          component ? `Componente:${component}` : "",
          area ? `Área:${area}` : "",
          `O que o material ensina:${contentDescription.slice(0, 700)}`,
          "Escolha até 5 habilidades BNCC mais compatíveis com este material.",
          "Use somente os candidatos abaixo. Se nada for realmente compatível, responda vazio.",
          "Responda APENAS números separados por vírgula, ex: 2,5,1.",
          candidateLines.join("\n")
        ].filter(Boolean).join("\n");

        const geminiResponse = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0, maxOutputTokens: 30 }
            })
          }
        );

        const gemini = await geminiResponse.json();

        if (!geminiResponse.ok) {
          console.error("Gemini material error", geminiResponse.status, gemini);
          return json(
            { ok: false, error: "Não foi possível obter sugestões da IA", provider_status: geminiResponse.status },
            502
          );
        }

        const answer = String(gemini?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();

        const indexes = [
          ...new Set(
            (answer.match(/\d+/g) || [])
              .map(Number)
              .filter(n => Number.isInteger(n) && n >= 1 && n <= candidates.length)
          )
        ].slice(0, 5);

        const suggestions = indexes.map((n, position) => ({
          rank: position + 1,
          ...candidates[n - 1]
        }));

        const usage = gemini?.usageMetadata || {};

        return json({
          ok: true,
          model: "gemini-3.5-flash-lite",
          candidate_count: candidates.length,
          suggestions,
          usage: {
            prompt_tokens: usage.promptTokenCount ?? null,
            output_tokens: usage.candidatesTokenCount ?? null,
            total_tokens: usage.totalTokenCount ?? null,
            thoughts_tokens: usage.thoughtsTokenCount ?? null
          }
        });
      }

      // =========================================================
      // ROTA NÃO ENCONTRADA
      // =========================================================

      return json(
        {
          ok: false,
          error: "Rota não encontrada",
          path: url.pathname
        },
        404
      );

    } catch (error) {
      console.error(error);

      const map = {
        AUTH_MISSING: [
          401,
          "Login Google necessário"
        ],

        AUTH_INVALID: [
          401,
          "Token Google inválido ou expirado"
        ],

        AUTH_WRONG_AUDIENCE: [
          401,
          "Token não pertence ao Diário de Estudos"
        ],

        AUTH_PROFILE_FAILED: [
          401,
          "Não foi possível validar o perfil Google"
        ],

        AUTH_PROFILE_INCOMPLETE: [
          401,
          "Perfil Google incompleto"
        ],

        FAMILY_FORBIDDEN: [
          403,
          "Você não possui acesso a esta família"
        ],

        ADMIN_REQUIRED: [
          403,
          "Somente administradores podem realizar esta operação"
        ],

        GLOBAL_ADMIN_REQUIRED: [
          403,
          "Somente administradores do Diário de Estudos podem validar materiais"
        ],
      };

      if (map[error.message]) {
        const [status, message] =
          map[error.message];

        return json(
          {
            ok: false,
            error: message,
            ...(error.providerDetail ? {detail:String(error.providerDetail)} : {}),
            ...(error.providerStatus ? {provider_status:error.providerStatus} : {})
          },
          status
        );
      }

      return json(
        {
          ok: false,
          error: "Erro interno",
          detail: error.message
        },
        500
      );
    }
  }
};
