import { html } from './html.js';

// bare: a page for someone outside the company (no app links). For someone signed in, page() swaps the marked
// header, rail and bottom bar for the full navigation (lib/views/nav.js); the simple header stays as a fallback.
export function layout({ title, body, entityName = '', csrf = null, wide = false, flash = null, bare = false }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Financial Books</title>
<meta name="theme-color" content="#0f5c5c">
<link rel="manifest" href="/public/manifest.webmanifest">
<link rel="icon" href="/public/icons/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/public/icons/icon-192.png">
<link rel="stylesheet" href="/public/app.css">
<script src="/public/app.js" defer></script>
</head>
<body>
<!--fb:nav-top--><header class="topbar">
  ${bare ? html`<span class="brand">${entityName || 'Financial Books'}</span>` : html`<a class="brand" href="/customers">Financial Books</a>
  <span class="company">${entityName}</span>`}
  ${bare ? '' : html`<nav class="topnav">
    <a href="/customers">Customers</a>
    ${csrf ? html`<a href="/vendors">Vendors</a><a href="/deposits">Deposits</a><a href="/time">Time</a><a href="/reports">Reports</a><a href="/tools">Tools</a><a href="/settings">Settings</a>` : ''}
    ${csrf ? html`<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button class="link">Sign out</button></form>` : ''}
  </nav>`}
</header><!--/fb:nav-top-->
<div class="shell"><!--fb:nav-rail--><!--/fb:nav-rail-->
<main class="${wide ? 'main wide' : 'main'}">
${flash ? html`<p class="flash ${flash.kind}" role="status">${flash.text}</p>` : ''}
${body}
</main>
</div><!--fb:nav-bottom--><!--/fb:nav-bottom-->
</body>
</html>`;
}

export function messagePage({ title, message, entityName, csrf }) {
  return layout({ title, entityName, csrf, body: html`<section class="card message"><h1>${title}</h1><p>${message}</p><p><a href="/customers">Back to customers</a></p></section>` });
}
