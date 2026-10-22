import { authenticateBearer } from '../../lib/integration/auth.js';
import { isDemo } from '../../lib/domain/demo.js';
import { IntegrationError,refuse,readIntegrationCompany } from '../../lib/integration/policy.js';
import { writeDocument } from '../../lib/integration/documents.js';
import { writePayment } from '../../lib/integration/payments.js';
import { readSettlements,readDocumentSettlement } from '../../lib/integration/settlements.js';
import { setActor } from '../../lib/audit.js';
import { clientIp } from './http.js';

const prefix='/api/integration/v1',MAX_BODY=128*1024;
function bodyBytes(req) {
  if(Number(req.headers['content-length'])>MAX_BODY){req.resume();return Promise.reject(new IntegrationError(413,'body_too_large','Request exceeds 128 KiB.'));}
  return new Promise((resolve,reject)=>{
    let size=0;const chunks=[];
    const done=(error)=>{req.off('data',data);req.off('end',end);req.off('error',failed);req.off('aborted',aborted);if(error){req.resume();reject(error);}else resolve(Buffer.concat(chunks));};
    const data=chunk=>{size+=chunk.length;if(size>MAX_BODY)done(new IntegrationError(413,'body_too_large','Request exceeds 128 KiB.'));else chunks.push(chunk);};
    const end=()=>done();const failed=()=>done(new IntegrationError(400,'invalid_body','Unable to read request body.'));const aborted=failed;
    req.on('data',data);req.once('end',end);req.once('error',failed);req.once('aborted',aborted);
  });
}
async function jsonBody(req) {
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type']??''))refuse(415,'content_type','Use application/json.');
  const bytes=await bodyBytes(req);let value;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{refuse(400,'invalid_json','Malformed JSON.');}
  if(!value||typeof value!=='object'||Array.isArray(value))refuse(400,'invalid_json','JSON body must be an object.');
  return value;
}
export async function integrationRoutes({req,res,path,url,pool,env,now}) {
  const send=(status,body,extra={})=>{
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});res.end(JSON.stringify(body));
  };
  try {
    if (isDemo(env)) refuse(403,'demo_disabled','Integration API is turned off in this public demo.');
    const identity=await authenticateBearer(pool,{authorization:req.headers.authorization,now:typeof now==='function'?now():now,ip:clientIp(req,env)});
    setActor(identity.actor);
    const route=path.slice(prefix.length),direct=/^\/documents\/(.+)\/settlement$/.exec(route);
    const writes={'/invoices':['invoice',writeDocument,'documents:write'],'/bills':['bill',writeDocument,'documents:write'],
      '/customer-payments':['customer-payment',writePayment,'payments:write'],'/bill-payments':['bill-payment',writePayment,'payments:write']};
    const read=route==='/companies'||route==='/settlements'||direct;
    if(!read&&!Object.hasOwn(writes,route))refuse(404,'not_found','Integration route not found.');
    if(req.method!==(read?'GET':'POST'))refuse(405,'method_not_allowed','Method not allowed.');
    const scope=route==='/companies'?null:read?'settlements:read':writes[route][2];
    if(scope&&!identity.scopes.includes(scope))refuse(403,'scope_required','Required integration scope is missing.');
    let result;
    if(route==='/companies')result=await readIntegrationCompany(pool,identity);
    else if(route==='/settlements') {
      if([...url.searchParams.keys()].some(k=>!['after_ref_id','limit'].includes(k))||['after_ref_id','limit'].some(k=>url.searchParams.getAll(k).length>1))refuse(422,'invalid_paging','Invalid settlement query.');
      const limit=url.searchParams.get('limit')??'100';if(!/^[1-9]\d{0,2}$/.test(limit))refuse(422,'invalid_paging','Invalid settlement page size.');
      result=await readSettlements(pool,{identity,afterRefId:url.searchParams.get('after_ref_id')??'0',limit:Number(limit)});
    } else if(direct) {
      let sourceRef;try{sourceRef=decodeURIComponent(direct[1]);}catch{refuse(400,'invalid_path','Invalid encoded reference.');}
      result=await readDocumentSettlement(pool,{identity,sourceRef});
    } else {
      const [kind,writer]=writes[route];result=await writer(pool,{identity,kind,body:await jsonBody(req)});
    }
    send(result.status==='created'?201:200,result);
  } catch(error) {
    const known=error instanceof IntegrationError;
    send(known?error.status:500,{error:{code:known?error.code:'internal_error',message:known?error.message:'Integration request failed.',...(known&&error.field?{field:error.field}:{})}},
      {...(error.retryAfter?{'Retry-After':String(error.retryAfter)}:{}),...(error.status===413?{Connection:'close'}:{})});
  }
}
