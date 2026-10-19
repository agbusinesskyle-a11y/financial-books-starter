import net from 'node:net';
import SMTPConnection from 'nodemailer/lib/smtp-connection/index.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

// The SMTP protocol decides acceptance; entering send() does not. Own every socket,
// including the unconnected one and both sides of a TLS upgrade, until local close.
export async function sendBoundedSmtp({host,port,security,user,password,from,replyTo,to,subject,text,
  deadlineMs=30000,mono=()=>performance.now(),socketFactory=()=>new net.Socket()}){
  if(!Number.isFinite(deadlineMs)||deadlineMs<=0||deadlineMs>30000)throw new Error('Invalid SMTP deadline');
  const started=mono(),cancelAt=started+Math.max(0,deadlineMs-1000),owned=new Map();
  let conn,timer,finishing=false,dataPossible=false,accepted=false,resolve;
  const result=new Promise(r=>resolve=r);
  const own=socket=>{
    if(socket&&!owned.has(socket)){
      owned.set(socket,new Promise(done=>{if(socket.closed)done();else socket.once('close',done);}));
      socket.on('error',()=>{});
      if(finishing)socket.destroy();
    }
    return socket;
  };
  const finish=async(error=null)=>{
    if(finishing)return;finishing=true;clearTimeout(timer);
    const refused=error?.responseCode>=400&&error.responseCode<600;
    const status=accepted?'sent':refused||!dataPossible?'failed':'unknown';
    const detail=accepted?'SMTP accepted the message':refused?`SMTP refused the message (${error.responseCode})`:
      dataPossible?'SMTP acceptance could not be established':'SMTP ended before message data';
    try{conn?.close();}catch{}
    for(const socket of owned.keys())socket.destroy();
    await Promise.all(owned.values());
    // Give local peer teardown callbacks a turn too; no network work survives this point.
    await new Promise(setImmediate);
    resolve({status,detail});
  };
  const ready=()=>{if(finishing)return false;if(mono()>=cancelAt){void finish();return false;}return true;};
  timer=setTimeout(()=>void finish(),Math.max(0,cancelAt-mono()));
  try{
    const raw=own(socketFactory());
    // Nodemailer's provided-socket DNS callback may arrive after cancellation.
    // A late callback must never reconnect the raw socket we already destroyed.
    const connect=raw.connect;
    raw.connect=function(...args){if(!ready())return this;return connect.apply(this,args);};
    conn=new SMTPConnection({host,port,socket:raw,secure:security==='tls',requireTLS:security==='starttls',
      connectionTimeout:deadlineMs,greetingTimeout:deadlineMs,socketTimeout:deadlineMs,dnsTimeout:deadlineMs});
    // Nodemailer replaces _socket synchronously in both implicit TLS and STARTTLS.
    // Keep the former handle as well as the replacement, even during a stalled handshake.
    let socket=conn._socket;
    Object.defineProperty(conn,'_socket',{configurable:true,get:()=>socket,set:value=>{socket=own(value);}});
    const actionData=conn._actionDATA;
    conn._actionDATA=function(response,callback){if(/^[23]/.test(response))dataPossible=true;return actionData.call(this,response,callback);};
    const actionFinal=conn._actionSMTPStream;
    conn._actionSMTPStream=function(response,callback){if(/^2/.test(response))accepted=true;return actionFinal.call(this,response,callback);};
    conn.on('error',error=>void finish(error));
    conn.on('end',()=>{if(!finishing)void finish();});
    const message=new MailComposer({from,replyTo,to,subject,text,disableFileAccess:true,disableUrlAccess:true}).compile();
    const envelope=message.getEnvelope();
    message.build((error,bytes)=>{
      if(error){void finish(error);return;}if(!ready())return;
      conn.connect(error=>{
        if(error){void finish(error);return;}if(!ready())return;
        const send=()=>{if(!ready())return;conn.send(envelope,bytes,(error)=>void finish(error));};
        if(user)conn.login({user,pass:password},error=>{if(error)void finish(error);else send();});else send();
      });
    });
  }catch(error){void finish(error);}
  return result;
}
