import { isIsoDate } from '../domain/dates.js';
import { parseQuantity,lineAmount } from '../domain/lines.js';
import { parseSignedMoney } from '../domain/money.js';
import { refuse } from './policy.js';
export { IntegrationError } from './policy.js';

const bad=field=>refuse(422,'invalid_input','Invalid or unsupported accounting input.',field);
export function keys(value,allowed,field='body') {
  if (!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))) bad(field);
}
export function text(value,max,field,{empty=false}={}) {
  if (typeof value!=='string'||value.length>max||(!empty&&!value.length)||value!==value.trim()||/[\x00-\x1f\x7f]/.test(value)) bad(field);
  return value;
}
export function cents(value,field,{positive=false,nonzero=false}={}) {
  if (!Number.isSafeInteger(value)||(positive&&value<=0)||(nonzero&&value===0)) bad(field);
  return value;
}
export const moneyText=n=>`${n<0?'-':''}${BigInt(Math.abs(n))/100n}.${String(BigInt(Math.abs(n))%100n).padStart(2,'0')}`;
const date=(v,f)=>{if(!isIsoDate(v))bad(f);return v;};
const sum=(values,field)=>{
  const n=values.reduce((a,b)=>a+BigInt(b),0n);
  if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))bad(field);
  return Number(n);
};
export function validateDocument(kind,body) {
  if(!['invoice','bill'].includes(kind))bad('kind');
  const party=kind==='invoice'?'customer_name':'vendor_name';
  keys(body,['source_ref','doc_number',party,'txn_date','due_date','terms_name','memo','total_cents','lines','adopt_only',...(kind==='bill'?['approve']:[])]);
  text(body.source_ref,200,'source_ref');text(body.doc_number,30,'doc_number');text(body[party],200,party);
  date(body.txn_date,'txn_date');date(body.due_date,'due_date');
  if(body.due_date<body.txn_date)bad('due_date');
  if(body.terms_name!==undefined)text(body.terms_name,60,'terms_name');
  if(body.memo!==undefined)text(body.memo,1000,'memo',{empty:true});
  for(const k of ['approve','adopt_only'])if(body[k]!==undefined&&typeof body[k]!=='boolean')bad(k);
  cents(body.total_cents,'total_cents',{positive:true});
  if(!Array.isArray(body.lines)||body.lines.length<1||body.lines.length>500)bad('lines');
  body.lines.forEach((l,i)=>{
    const f=`lines.${i}`;
    keys(l,['item_name','account_name','description','quantity','rate_cents','amount_cents'],f);
    if((Object.hasOwn(l,'item_name')?1:0)+(Object.hasOwn(l,'account_name')?1:0)!==1)bad(f);
    if(l.description!==undefined)text(l.description,500,`${f}.description`,{empty:true});
    cents(l.amount_cents,`${f}.amount_cents`,{nonzero:true});
    if(Object.hasOwn(l,'item_name')) {
      text(l.item_name,100,`${f}.item_name`);
      if(typeof l.quantity!=='string'||!/^\d+(?:\.\d{1,4})?$/.test(l.quantity))bad(`${f}.quantity`);
      const qty=parseQuantity(l.quantity);if(qty===null)bad(`${f}.quantity`);
      cents(l.rate_cents,`${f}.rate_cents`);
      if(parseSignedMoney(moneyText(l.rate_cents))!==l.rate_cents)bad(`${f}.rate_cents`);
      const expected=Math.sign(l.rate_cents)*lineAmount(qty,Math.abs(l.rate_cents));
      if(!Number.isSafeInteger(expected)||expected!==l.amount_cents)bad(`${f}.amount_cents`);
    } else {
      if(kind!=='bill'||Object.hasOwn(l,'quantity')||Object.hasOwn(l,'rate_cents'))bad(f);
      text(l.account_name,200,`${f}.account_name`);
      if(parseSignedMoney(moneyText(l.amount_cents))!==l.amount_cents)bad(`${f}.amount_cents`);
    }
  });
  if(sum(body.lines.map(l=>l.amount_cents),'total_cents')!==body.total_cents)bad('total_cents');
  return structuredClone(body);
}

export function validatePayment(kind,body) {
  if(!['customer-payment','bill-payment'].includes(kind))bad('kind');
  const customer=kind==='customer-payment',party=customer?'customer_name':'vendor_name',account=customer?'deposit_to_account_name':'bank_account_name';
  keys(body,['source_ref',party,'txn_date','amount_cents','method','reference','memo',account,'applications',...(!customer?['check_no']:[])]);
  text(body.source_ref,200,'source_ref');text(body[party],200,party);date(body.txn_date,'txn_date');
  cents(body.amount_cents,'amount_cents',{positive:true});
  if(parseSignedMoney(moneyText(body.amount_cents))!==body.amount_cents)bad('amount_cents');
  text(body.method,50,'method');text(body.reference,50,'reference',{empty:true});
  if(body.memo!==undefined)text(body.memo,1000,'memo',{empty:true});
  if(!(customer&&body[account]===null))text(body[account],200,account);
  if(!customer) {
    if(!['Check','ACH','Credit card','Debit card','Cash','Other'].includes(body.method))bad('method');
    if(body.method==='Check') {if(typeof body.check_no!=='string'||!/^\d{1,9}$/.test(body.check_no))bad('check_no');}
    else if(Object.hasOwn(body,'check_no'))bad('check_no');
  }
  if(!Array.isArray(body.applications)||body.applications.length>500||(!customer&&!body.applications.length))bad('applications');
  body.applications.forEach((a,i)=>{
    const f=`applications.${i}`;
    keys(a,['source_ref','doc_number','amount_cents','applied_on'],f);
    if((Object.hasOwn(a,'source_ref')?1:0)+(Object.hasOwn(a,'doc_number')?1:0)!==1)bad(f);
    if(a.source_ref!==undefined)text(a.source_ref,200,`${f}.source_ref`);else text(a.doc_number,30,`${f}.doc_number`);
    cents(a.amount_cents,`${f}.amount_cents`,{positive:true});
    if(a.applied_on!==undefined)date(a.applied_on,`${f}.applied_on`);
    if(a.applied_on<body.txn_date||(!customer&&a.applied_on!==undefined&&a.applied_on!==body.txn_date))bad(`${f}.applied_on`);
  });
  const applied=sum(body.applications.map(a=>a.amount_cents),'applications');
  if(applied>body.amount_cents||(!customer&&applied!==body.amount_cents))bad('applications');
  return structuredClone(body);
}
