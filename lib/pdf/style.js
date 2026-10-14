import { formatAddress } from '../views/format.js';

// The company's form style (Settings → Form styles) as the PDF renderers use it. After applyStyle(doc, entity),
// doc.fb holds the fonts (r regular, b bold, i italic), the accent color and the style switches.

const FACES = {
  helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique'],
  times: ['Times-Roman', 'Times-Bold', 'Times-Italic'],
  courier: ['Courier', 'Courier-Bold', 'Courier-Oblique'],
};
export const DEFAULT_STYLE = { showLogo: true, accent: '#0f5c5c', font: 'helvetica', showTerms: true, showDueDate: true, showProject: true,
  showServiceDate: true, showMessage: true, footer: null };

export function applyStyle(doc, entity) {
  const style = { ...DEFAULT_STYLE, ...(entity.style ?? {}) };
  const [r, b, i] = FACES[style.font] ?? FACES.helvetica;
  doc.fb = { r, b, i, accent: style.accent, style };
  return doc.fb;
}

// Logo (if any and switched on), company name and contact line. Returns the y below it.
export function drawHeader(doc, entity) {
  const { fb } = doc;
  const left = doc.page.margins.left, width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let y = 54;
  if (fb.style.showLogo && entity.logo) {
    try {
      doc.image(entity.logo, left, 36, { fit: [170, 50] });
      y = 92;
    } catch { /* an unreadable image is skipped rather than failing the whole PDF */ }
  }
  doc.font(fb.b).fontSize(y > 54 ? 13 : 16).fillColor(fb.accent).text(entity.name, left, y, { width: width - 200 });
  const contact = [formatAddress(entity.address), entity.phone, entity.email, entity.website].filter(Boolean).join('  ·  ');
  doc.font(fb.r).fontSize(9).fillColor('#333').text(contact, left, doc.y + 4, { width: width - 200 });
  return doc.y;
}

// The footer text at the bottom of the current page.
export function drawFooter(doc) {
  const text = doc.fb.style.footer;
  if (!text) return;
  const left = doc.page.margins.left, width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font(doc.fb.r).fontSize(8).fillColor('#555').text(text, left, doc.page.height - 50, { width, align: 'center', height: 30, ellipsis: true });
  doc.page.margins.bottom = bottom;
}
