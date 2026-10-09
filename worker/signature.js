// Branded HTML version of outgoing Outbox emails, in Rhino Insurance's black and yellow (rhinoinsuranceco.com).
// The editable draft stays plain text; when it is sent, the plain "--" signature block at the end is swapped
// for this table-based signature (inline styles, one hosted logo image) so it holds up in Gmail, Outlook and phones.

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BLACK = "#080808", YELLOW = "#FFD814", SOFT = "#B5B5B5", INK = "#1B1B1B";
const FONT = "font-family:Arial,Helvetica,sans-serif;";
const LOGO = "https://renewal-desk.acigedi.workers.dev/sig/rhino-logo.png";
const SITE = "https://rhinoinsuranceco.com";

export const SIGNATURE_HTML = `
<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="520" style="width:520px;max-width:100%;border-collapse:collapse;margin-top:20px;background:${BLACK};border-radius:10px;${FONT}" bgcolor="${BLACK}">
  <tr><td colspan="2" height="16" style="height:16px;line-height:16px;font-size:0;">&nbsp;</td></tr>
  <tr>
    <td valign="middle" width="168" style="width:168px;padding:0 18px 0 22px;">
      <a href="${SITE}" style="text-decoration:none;"><img src="${LOGO}" width="150" height="52" alt="Rhino Insurance" style="display:block;border:0;width:150px;height:52px;"></a>
    </td>
    <td valign="middle" style="padding:4px 22px 4px 18px;border-left:2px solid ${YELLOW};">
      <div style="${FONT}font-size:18px;font-weight:bold;color:#FFFFFF;line-height:22px;">Eduard Kaplun <span style="font-size:13px;font-weight:normal;color:${SOFT};">&nbsp;Founder</span></div>
      <div style="${FONT}font-size:11px;font-weight:bold;color:${YELLOW};line-height:18px;letter-spacing:1.5px;text-transform:uppercase;white-space:nowrap;">Rhino Insurance Group LLC</div>
      <div style="${FONT}font-size:13px;line-height:20px;padding-top:8px;">
        <a href="tel:+12533359649" style="color:#FFFFFF;text-decoration:none;">(253) 335-9649</a><br>
        <a href="mailto:Eduard@rhino.insure" style="color:#FFFFFF;text-decoration:none;">Eduard@rhino.insure</a><br>
        <a href="${SITE}" style="color:${SOFT};text-decoration:none;">rhinoinsuranceco.com</a>
      </div>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;margin-top:12px;">
        <tr><td bgcolor="${YELLOW}" style="background:${YELLOW};border-radius:6px;">
          <a href="${SITE}/quote" style="display:inline-block;padding:7px 14px;${FONT}font-size:12px;font-weight:bold;color:${BLACK};text-decoration:none;">Get a Quote &rarr;</a>
        </td></tr>
      </table>
    </td>
  </tr>
  <tr><td colspan="2" style="padding:16px 22px 14px 22px;${FONT}font-size:11px;color:${SOFT};line-height:16px;">Auto &middot; Home &middot; Commercial &middot; Builder's Risk &middot; Surety Bonds &nbsp;<span style="color:${YELLOW};">|</span>&nbsp; Strong Coverage. Built to Protect.</td></tr>
</table>`;

// Text body -> HTML body: escape it, keep line breaks, and replace a trailing "--" signature block with SIGNATURE_HTML.
export function bodyHtml(text){
  const t = String(text || "").replace(/\r\n/g, "\n");
  const m = t.match(/\n--\s*\nEduard Kaplun[\s\S]*$/);
  const main = (m ? t.slice(0, m.index) : t).trimEnd();
  return `<!doctype html><html><body style="margin:0;padding:0;">` +
    `<div style="${FONT}font-size:14px;color:${INK};line-height:21px;">${esc(main).replace(/\n/g, "<br>")}</div>` +
    `${SIGNATURE_HTML}</body></html>`;
}
