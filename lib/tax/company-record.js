// lib/tax/company-record.js
// One company record (Tax Books T2, owner request 2026-10-16; Codex t2-plan-r1 B9): a company and its optional tax setup are created in
// ONE transaction, so a refused or failed tax setup never leaves a company behind without it. saveTax is the profile writer (a test may
// pass one that fails, to prove the rollback).
import { withTransaction } from '../db.js';
import { createCompanyIn } from '../data/companies.js';
import { saveProfileIn } from './periods.js';

export async function createCompanyWithTax(pool, { orgId, company, tax = null, actor, saveTax = saveProfileIn }) {
  return withTransaction(pool, async tx => {
    const entityId = await createCompanyIn(tx, { orgId, ...company });
    if (tax) await saveTax(tx, { orgId, entityId, fields: tax, actor });
    return entityId;
  });
}
