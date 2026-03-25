
const tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getGraphAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Missing env vars: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET");
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Token request failed: ${JSON.stringify(data)}`);
  }

  const expiresInMs = (data.expires_in || 3600) * 1000;
  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = Date.now() + expiresInMs - 60_000;

  return tokenCache.accessToken;
}

function normalizeEmails(input) {
  const arr = Array.isArray(input) ? input : [input];

  const flat = arr
    .filter(Boolean)
    .flatMap((x) => String(x).split(",")) // comma split
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((addr) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr));

  return Array.from(new Set(flat));
}

function toRecipients(input) {
  return normalizeEmails(input).map((address) => ({
    emailAddress: { address },
  }));
}

async function sendMail({ to, subject, html, text, cc, bcc }) {
  const fromMailbox = process.env.MS_GRAPH_FROM;

  if (!fromMailbox) throw new Error("Missing MS_GRAPH_FROM in env");
  if (!to) throw new Error("Missing 'to'");

  const resolvedTo = toRecipients(to);
  if (!resolvedTo.length) throw new Error("No valid recipients in 'to'");

  const accessToken = await getGraphAccessToken();

  const content = html ?? text ?? "";
  const contentType = html ? "HTML" : "Text";

  const payload = {
    message: {
      subject: subject || "",
      body: { contentType, content },
      toRecipients: resolvedTo,
    },
    saveToSentItems: true,
  };

  const resolvedCc = cc ? toRecipients(cc) : [];
  const resolvedBcc = bcc ? toRecipients(bcc) : [];

  if (resolvedCc.length) payload.message.ccRecipients = resolvedCc;
  if (resolvedBcc.length) payload.message.bccRecipients = resolvedBcc;

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromMailbox)}/sendMail`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (res.status !== 202) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Graph sendMail failed (${res.status}): ${errText}`);
  }

  return { ok: true, status: res.status };
}

module.exports = { sendMail };