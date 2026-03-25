function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderTemplate(tpl = "", vars = {}, safeKeys = []) {
  return String(tpl).replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    const val = vars?.[key];
    if (val === undefined || val === null) return "";
    const str = String(val);
    if (safeKeys.includes(key)) return str;
    return escapeHtml(str);
  });
}

module.exports = { renderTemplate, escapeHtml };
