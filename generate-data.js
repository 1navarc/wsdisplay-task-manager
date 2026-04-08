const {Pool}=require('pg'),fs=require('fs');
const pool=new Pool({host:'127.0.0.1',port:9470,user:'postgres',password:'WSDisplay2026Secure!',database:'wsdisplay_email'});
async function run(){
const r=await pool.query("SELECT c.id,c.subject,c.from_email,c.status,c.priority,c.created_at,m.body_text,m.body_html FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id ORDER BY c.created_at DESC");
const cm={};
r.rows.forEach(function(x){if(!cm[x.id]){var e=x.from_email||'';var n=e.split('<')[0].trim()||e;cm[x.id]={id:x.id,from:e,name:n,subject:x.subject||'(no subject)',body:x.body_text||x.body_html||'',status:x.status||'open',priority:x.priority||'medium',mailbox:'info@modco.com',created:x.created_at?x.created_at.toISOString():new Date().toISOString(),tags:[],assignee:'Craig'};}});
var c=Object.values(cm);
fs.writeFileSync('public/data.js','var conversations = '+JSON.stringify(c,null,2)+';');
console.log('Generated '+c.length+' conversations');
c.forEach(function(x){console.log(' - '+x.subject);});
await pool.end();
}
run().catch(function(e){console.error(e);process.exit(1);});
