import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

// Synthetic local CA: trust is installed only by the test, with verification still enabled.
const fixture = name => readFileSync(new URL(`./fixtures/morning-tls/${name}`,import.meta.url));
export function trustMorningTestCa(t){
  const old=tls.getCACertificates('default');
  tls.setDefaultCACertificates([...old,fixture('ca.pem').toString()]);
  t.after(()=>tls.setDefaultCACertificates(old));
}
export async function fakeSmtp(t,{security='none',scenario='accept'}={}){
  const sockets=new Set(),closed=new Set(),messages=[],commands=[];
  let lastData=0,bytes=0;
  const context=tls.createSecureContext({key:fixture('server-key.pem'),cert:fixture('server.pem')});
  const server=net.createServer(raw=>{
    sockets.add(raw);raw.on('error',()=>{});raw.on('close',()=>closed.add(raw));
    raw.on('data',b=>{lastData=performance.now();bytes+=b.length;});
    if(scenario==='early-error'){raw.destroy();return;}
    const secure=(socket,greet)=>{
      if(scenario==='handshake-stall')return;
      const wrapped=new tls.TLSSocket(socket,{isServer:true,secureContext:context});
      sockets.add(wrapped);wrapped.on('error',()=>{});wrapped.on('close',()=>closed.add(wrapped));
      wrapped.on('secure',()=>protocol(wrapped,true,greet));
    };
    const protocol=(socket,encrypted,greet)=>{
      let buffer='',data=false;
      if(greet&&scenario!=='greeting-stall')socket.write('220 localhost Sample SMTP\r\n');
      const onData=chunk=>{
        lastData=performance.now();buffer+=chunk.toString();
        while(buffer.length){
          if(data){
            const end=buffer.indexOf('\r\n.\r\n');if(end<0)return;
            messages.push(buffer.slice(0,end));buffer=buffer.slice(end+5);data=false;
            if(scenario==='data-stall')return;
            if(scenario==='data-lost'){socket.destroy();return;}
            socket.write(scenario==='data-refuse'?'550 Message refused\r\n':'250 Message accepted\r\n');continue;
          }
          const end=buffer.indexOf('\r\n');if(end<0)return;
          const line=buffer.slice(0,end);buffer=buffer.slice(end+2);commands.push(line);
          if(/^EHLO|^HELO/.test(line))socket.write(`250-localhost\r\n${security==='starttls'&&!encrypted?'250-STARTTLS\r\n':''}250-AUTH PLAIN\r\n250 SIZE 1000000\r\n`);
          else if(line==='STARTTLS'){
            socket.removeListener('data',onData);socket.write('220 Begin TLS\r\n');secure(socket,false);return;
          }else if(line.startsWith('AUTH'))socket.write(scenario==='auth-fail'?'535 Authentication refused\r\n':'235 Authenticated\r\n');
          else if(line.startsWith('MAIL'))socket.write('250 Sender accepted\r\n');
          else if(line.startsWith('RCPT'))socket.write(scenario==='rcpt-refuse'?'550 Recipient refused\r\n':'250 Recipient accepted\r\n');
          else if(line==='DATA'){data=true;socket.write('354 Send message\r\n');}
          else if(line==='QUIT'){if(scenario!=='quit-stall')socket.end('221 Goodbye\r\n');}
          else socket.write('250 OK\r\n');
        }
      };
      socket.on('data',onData);
    };
    if(security==='tls')secure(raw,true);else protocol(raw,false,true);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));});
  return {host:'127.0.0.1',port:server.address().port,security,sockets,closed,messages,commands,get lastData(){return lastData;},get bytes(){return bytes;}};
}
