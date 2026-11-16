/* Owner-only access page, rendered server-side with no scripts. */
import { escapeHtml as h } from "./lib.mjs";

export const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const SEATS = 50;

const date = (iso) => (iso ? h(String(iso).slice(0, 10)) : "");

function shareLink(email, siteUrl) {
  const q = `subject=${encodeURIComponent("Fitness dashboard")}&body=${encodeURIComponent(`${siteUrl}\nSign in with: ${email}`)}`;
  return `mailto:${encodeURIComponent(email)}?${q}`;
}

const action = (email, buttons) => `<form method="post"><input type="hidden" name="email" value="${h(email)}">${buttons}</form>`;

export function adminPage({ pending, users, siteUrl }) {
  const pendingRows = pending.map((r) => `<tr>
      <td>${h(r.name)}</td><td>${h(r.email)}</td><td class="note">${h(r.note)}</td><td>${date(r.at)}</td>
      <td>${action(r.email, '<button name="action" value="approve">Approve</button><button name="action" value="deny" class="quiet">Deny</button>')}</td>
    </tr>`).join("");
  const userRows = users.map((u) => `<tr>
      <td>${h(u.email)}</td><td>${h(u.name)}</td><td>${date(u.at)}</td>
      <td><a class="button" href="${h(shareLink(u.email, siteUrl))}">Send link</a>${action(u.email, '<button name="action" value="remove" class="quiet">Remove</button>')}</td>
    </tr>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Fitness access</title>
<style>
  :root { color-scheme: dark; --bg: #0f141b; --card: #151c25; --border: #263040; --text: #e6edf3; --muted: #8b98a5; --accent: #58a6ff; --danger: #f85149; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-inline-size: 960px; margin-inline: auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 16px; margin: 32px 0 10px; }
  h2 span, .meta { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
  .meta { margin: 4px 0 0; }
  a { color: var(--accent); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow-x: auto; }
  table { inline-size: 100%; border-collapse: collapse; }
  th, td { padding: 10px 12px; text-align: start; border-block-end: 1px solid var(--border); vertical-align: middle; }
  tr:last-child td { border-block-end: 0; }
  th { color: var(--muted); font-weight: 500; font-size: 12.5px; }
  td.note { color: var(--muted); max-inline-size: 280px; overflow-wrap: anywhere; }
  td:last-child { white-space: nowrap; text-align: end; }
  form { display: inline-flex; gap: 6px; margin: 0; }
  button, .button, input { font: inherit; border-radius: 8px; min-block-size: 32px; padding: 4px 12px; }
  button, .button { cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: #0b0f14; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; margin-inline-start: 6px; }
  button.quiet { background: transparent; color: var(--muted); border-color: var(--border); font-weight: 500; }
  button.quiet:hover { color: var(--danger); border-color: var(--danger); }
  input { background: var(--bg); color: var(--text); border: 1px solid var(--border); min-inline-size: min(320px, 70vw); }
  .add { padding: 12px; }
  .add button { margin: 0; }
  .empty { color: var(--muted); padding: 14px 12px; margin: 0; }
  .sr-only { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <h1>Fitness access</h1>
  <p class="meta">Approved ${users.length + 1} / ${SEATS} seats · <a href="${h(siteUrl)}">Dashboard</a></p>

  <h2>Pending <span>${pending.length}</span></h2>
  <div class="card">${pending.length ? `<table><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Note</th><th scope="col">Requested</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${pendingRows}</tbody></table>` : '<p class="empty">None</p>'}</div>

  <h2>Approved <span>${users.length}</span></h2>
  <div class="card">${users.length ? `<table><thead><tr><th scope="col">Email</th><th scope="col">Name</th><th scope="col">Since</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${userRows}</tbody></table>` : '<p class="empty">None</p>'}</div>

  <h2>Add</h2>
  <div class="card add">
    <form method="post"><input aria-label="Email" type="email" name="email" required autocomplete="off" placeholder="name@example.com"><button name="action" value="approve">Approve</button></form>
  </div>
</main>
</body>
</html>`;
}
