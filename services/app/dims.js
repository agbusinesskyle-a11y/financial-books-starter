// Class, location and tags from an editor form (shared by the customer, vendor and journal entry editors).
// Fields the form didn't show are left undefined so a save doesn't clear them.
export function dimsFromForm(form) {
  const out = {};
  if (form.has('class_id')) out.classId = form.get('class_id') ?? '';
  if (form.has('location_id')) out.locationId = form.get('location_id') ?? '';
  if (form.has('tags_shown')) out.tagIds = form.getAll('tag_ids');
  return out;
}

// Form values -> what applyTxnDimensions takes.
export function dimsForSave(v) {
  const id = x => (/^\d{1,18}$/.test(String(x ?? '')) ? Number(x) : null);
  const dims = {};
  if (v.classId !== undefined) dims.classId = id(v.classId);
  if (v.locationId !== undefined) dims.locationId = id(v.locationId);
  if (v.tagIds !== undefined) dims.tagIds = v.tagIds.map(id).filter(Boolean);
  return dims;
}
