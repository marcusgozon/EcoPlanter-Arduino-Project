#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <Preferences.h>
#include <Adafruit_PWMServoDriver.h>

// Needs ESP32 Arduino core 3.x (ledcAttach / ledcWrite by pin)

const char* AP_SSID = "EcoPlanter";
const char* AP_PASS = "plant1234";

// L298N wheels
const int IN1 = 25, IN2 = 4, ENA = 33;   // IN2 moved 26 -> 4 (fixes left motors not reversing)
const int IN3 = 27, IN4 = 14, ENB = 32;
int speedPct = 60;                 // set live from the page

// Pump (MOSFET module IN screw on GPIO 23)
const int PUMP_PIN = 23;
const bool PUMP_ACTIVE_HIGH = true;
const int PUMP_POWER = 100;        // 0-100
unsigned long pumpOff = 0;         // dead-man timer: pump stops if the page stops asking
bool pumpOn = false;

// PCA9685 servo channels
const int CH_BASE = 0;             // MG996R base
const int CH_SHOULDER = 2;
const int CH_ELBOW = 3;
const int CH_LIFT = 4;
const int CH_GATE = 5;
const int CH_DIGLOW = 8;           // micro servo that lowers the arm a little for digging
const int CH_DIG = 9;              // micro servo that digs

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);
Preferences prefs;
const int SLEW_US = 12;            // normal servo speed: microseconds per 10 ms
const int DIGLOW_SLEW_US = 12;     // micro servo that lowers the digger
const int DIG_SLEW_US = 30;        // digging micro servo swings faster
const int DIG_REPS = 8;            // left-and-right swings per dig
const int US_MIN = 450, US_MAX = 2400;

enum AxisId { AX_BASE, AX_SHOULDER, AX_ELBOW, AX_LIFT, AX_GATE, AX_DIGLOW, AX_DIG, AX_COUNT };

// New positions are appended at the end so saved calibration from older versions still loads.
enum PosId {
  P_BASE_CENTER, P_BASE_LEFT, P_BASE_RIGHT,
  P_SHOULDER_HOME, P_SHOULDER_WATER,
  P_ELBOW_UP, P_ELBOW_WATER,
  P_LIFT_UP, P_LIFT_DOWN,
  P_GATE_CLOSED, P_GATE_OPEN,
  P_DIGLOW_UP, P_DIGLOW_DOWN,
  P_DIG_LEFT, P_DIG_CENTER, P_DIG_RIGHT,
  P_COUNT
};
const int OLD_P_COUNT = 11;        // size of the previous version's saved block

// Left = watering arm to the front. Right = seeding turret to the front.
// Dig values are starting guesses: calibrate them on the Arm tab.
const int POS_DEFAULT[P_COUNT] = {
  1500, 2300, 700,   // base: center, left, right
  1500, 1000,        // shoulder: home, water
  1500, 1250,        // elbow: up, water
  450, 2300,         // lift: up, down
  1500, 1100,        // gate: closed, open
  1500, 1200,        // dig lower: up, down
  1300, 1500, 1700   // dig: left, center, right
};
const int POS_AXIS[P_COUNT] = {
  AX_BASE, AX_BASE, AX_BASE,
  AX_SHOULDER, AX_SHOULDER,
  AX_ELBOW, AX_ELBOW,
  AX_LIFT, AX_LIFT,
  AX_GATE, AX_GATE,
  AX_DIGLOW, AX_DIGLOW,
  AX_DIG, AX_DIG, AX_DIG
};
const int HOME_POS[AX_COUNT] = { P_BASE_CENTER, P_SHOULDER_HOME, P_ELBOW_UP, P_LIFT_UP, P_GATE_CLOSED, P_DIGLOW_UP, P_DIG_CENTER };
int pos[P_COUNT];

struct Axis { int ch; int cur; int target; int slew; };
Axis ax[AX_COUNT] = {
  {CH_BASE, 1500, 1500, SLEW_US},
  {CH_SHOULDER, 1500, 1500, SLEW_US},
  {CH_ELBOW, 1500, 1500, SLEW_US},
  {CH_LIFT, 1500, 1500, SLEW_US},
  {CH_GATE, 1500, 1500, SLEW_US},
  {CH_DIGLOW, 1500, 1500, DIGLOW_SLEW_US},
  {CH_DIG, 1500, 1500, DIG_SLEW_US}
};

// Dig routine state: swing left then right DIG_REPS times, then return to center.
bool digging = false;
int digRep = 0, digPhase = 0;      // phase 0 = heading left, 1 = heading right, 2 = returning to center

unsigned long lastSlew = 0, driveSeen = 0;
bool moving = false;
WebServer server(80);

const char PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>EcoPlanter</title>
<style>
:root{--bg:#E8EEE3;--card:#F6F9F2;--ink:#17261D;--mut:#5B6B60;--line:#CBD6C6;--leaf:#2E7A4D;--water:#1F6FB5;--amber:#C98A1B;--red:#B42F25;--soil:#7A5A32}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Avenir Next","Trebuchet MS",system-ui,sans-serif;padding-bottom:128px;-webkit-user-select:none;user-select:none}
header{position:sticky;top:0;z-index:5;background:var(--bg);padding:14px 16px 10px;border-bottom:1px solid var(--line)}
.top{max-width:460px;margin:0 auto}
h1{font-size:22px;margin:0 0 2px;letter-spacing:-.01em}
.st{font-size:13px;color:var(--mut)}
.st::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red);margin-right:6px}
.st.ok::before{background:var(--leaf)}
.tabs{display:flex;gap:6px;margin-top:10px;background:#D9E3D3;padding:4px;border-radius:12px}
.tabs button{flex:1;height:40px;border:1px solid transparent;border-radius:9px;background:transparent;font-family:inherit;font-weight:600;font-size:16px;color:var(--mut)}
.tabs button.on{background:var(--card);color:var(--ink);border-color:var(--line)}
main{max-width:460px;margin:0 auto;padding:14px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:14px;margin-bottom:12px}
.hint{font-size:13px;color:var(--mut);margin:10px 0 0;text-align:center}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.pad button{height:84px;border:0;border-radius:20px;background:var(--leaf);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-family:inherit;touch-action:none}
.pad b{font-size:28px;line-height:1}
.pad small{font-size:12px;opacity:.9}
.pad button.on{background:#1F5A38;transform:scale(.97)}
.lbl{display:flex;justify-content:space-between;align-items:baseline;font-weight:600}
.lbl output{font-variant-numeric:tabular-nums;color:var(--mut)}
input[type=range]{width:100%;height:44px;accent-color:var(--leaf);margin:0}
.hd{display:flex;justify-content:space-between;align-items:flex-start}
.hd h3{margin:0;font-size:18px}
.hd p{margin:2px 0 0;font-size:13px;color:var(--mut);max-width:260px}
.hd output{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.row{display:flex;align-items:center;gap:8px;margin-top:6px}
.nb{flex:none;width:44px;height:44px;border-radius:50%;border:1px solid var(--line);background:#fff;font-size:22px;color:var(--ink);font-family:inherit}
.nb:active{background:var(--line)}
.pre{display:flex;gap:8px;margin-top:8px}
.pre button{flex:1;height:54px;border:1.5px solid var(--leaf);border-radius:12px;background:transparent;color:var(--leaf);font-family:inherit;font-weight:700;font-size:15px;display:flex;flex-direction:column;align-items:center;justify-content:center}
.pre small{font-size:12px;font-weight:600;opacity:.8;font-variant-numeric:tabular-nums}
.sv .pre button{border-color:var(--amber);background:#FBF1DC;color:#7A4E00}
.dig{width:100%;height:54px;margin-top:8px;border:0;border-radius:12px;background:var(--soil);color:#fff;font-family:inherit;font-weight:700;font-size:16px}
.dig.on{background:var(--red)}
.sm{width:100%;height:50px;border-radius:14px;border:1.5px solid var(--line);background:var(--card);font-family:inherit;font-weight:700;font-size:15px;color:var(--ink);margin-bottom:12px}
.sv .sm{border-color:var(--amber);background:#FBF1DC;color:#7A4E00}
.foot{display:flex;gap:10px}
.foot button{flex:1;height:48px;border-radius:12px;border:1px solid var(--line);background:var(--card);font-family:inherit;font-weight:600;font-size:15px;color:var(--ink)}
.dock{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:10px 16px calc(10px + env(safe-area-inset-bottom))}
.dock div{max-width:460px;margin:0 auto;display:flex;gap:10px}
.stop{flex:none;width:96px;height:64px;border:0;border-radius:16px;background:var(--red);color:#fff;font-family:inherit;font-weight:700;font-size:16px}
.water{flex:1;height:64px;border:2px solid var(--water);border-radius:16px;background:#fff;color:var(--water);position:relative;overflow:hidden;font-family:inherit;font-weight:700;font-size:18px;touch-action:none}
.water::before{content:"";position:absolute;left:0;right:0;bottom:0;height:0;background:var(--water);transition:height .25s ease-out}
.water.on::before{height:100%;transition:height 4s linear}
.water span{position:relative;z-index:1}
.water.on span{color:#fff;transition:color .1s 1.8s}
#toast{position:fixed;left:50%;bottom:98px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:9px 14px;border-radius:10px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;white-space:nowrap;max-width:92vw;overflow:hidden;text-overflow:ellipsis}
#toast.show{opacity:1}
.hide{display:none}
button:focus-visible,input:focus-visible{outline:3px solid #8DB9F0;outline-offset:2px}
</style></head><body>
<header><div class="top">
<h1>EcoPlanter</h1>
<div id="st" class="st">Connecting</div>
<div class="tabs"><button id="t0" class="on">Drive</button><button id="t1">Arm</button></div>
</div></header>

<main>
<div id="p0">
  <div class="card">
    <div class="pad">
      <span></span><button data-m="f"><b>&#9650;</b><small>Forward</small></button><span></span>
      <button data-m="l"><b>&#9664;</b><small>Turn left</small></button><span></span><button data-m="r"><b>&#9654;</b><small>Turn right</small></button>
      <span></span><button data-m="b"><b>&#9660;</b><small>Back</small></button><span></span>
    </div>
    <p class="hint">Hold a button to drive. Let go to stop.</p>
  </div>
  <div class="card">
    <div class="lbl"><span>Wheel speed</span><output id="spv">60%</output></div>
    <input type="range" id="sp" min="20" max="100" step="5" value="60">
  </div>
</div>

<div id="p1" class="hide">
  <button class="sm" id="sm">Save mode is off</button>
  <div id="axes"></div>
  <div class="foot"><button id="home">Home all</button><button id="rs">Reset saved</button></div>
</div>
</main>

<div id="toast"></div>
<div class="dock"><div>
  <button class="stop" id="stop">Stop all</button>
  <button class="water" id="water"><span id="wt">Hold to water</span></button>
</div></div>

<script>
var $=function(i){return document.getElementById(i)};
var REPS=8;
var AX=[
 {n:'Base',note:'Turns the tool head. Left faces the watering arm forward, right faces the seeder.',p:[[1,'Left'],[0,'Center'],[2,'Right']]},
 {n:'Shoulder',note:'Lower joint of the watering arm.',p:[[3,'Home'],[4,'Water']]},
 {n:'Elbow',note:'Upper joint of the watering arm.',p:[[5,'Up'],[6,'Water']]},
 {n:'Lift',note:'Raises and lowers the seeder.',p:[[7,'Up'],[8,'Down']]},
 {n:'Gate',note:'Covers and uncovers the seed hole.',p:[[9,'Closed'],[10,'Open']]},
 {n:'Dig lower',note:'Lowers the digger a little into the soil.',p:[[11,'Up'],[12,'Down']]},
 {n:'Dig',note:'Swings left and right to loosen the soil.',p:[[13,'Left'],[14,'Center'],[15,'Right']],dig:true}
];
var speed=60,saveMode=false,lastInput=0,tt=null,sent=[],offs=[];

function online(ok){var e=$('st');e.className='st'+(ok?' ok':'');e.textContent=ok?'Connected':'No signal. Rejoin the EcoPlanter Wi-Fi.'}
function api(u){return fetch(u).then(function(r){online(true);return r.text()}).catch(function(){online(false);return ''})}
function toast(m){var t=$('toast');t.textContent=m;t.className='show';clearTimeout(tt);tt=setTimeout(function(){t.className=''},1800)}
function clampUs(v){return Math.min(2400,Math.max(450,v))}
function setSlider(i,v){$('s'+i).value=v;$('v'+i).textContent=v}
function sendAxis(i,v,force){var n=Date.now();if(force||n-(sent[i]||0)>70){sent[i]=n;api('/s?a='+i+'&us='+v)}}

function preset(i,id,label){
  if(saveMode){
    var v=$('s'+i).value;
    api('/save?id='+id+'&us='+v).then(function(){$('pv'+id).textContent=v;toast('Saved '+AX[i].n+' '+label+' = '+v)});
  }else{
    api('/g?id='+id).then(function(t){if(t){lastInput=Date.now();setSlider(i,t)}});
  }
}

AX.forEach(function(a,i){
  var d=document.createElement('section');d.className='card';
  d.innerHTML='<div class="hd"><div><h3>'+a.n+'</h3><p>'+a.note+'</p></div><output id="v'+i+'">1500</output></div>'+
   '<div class="row"><button class="nb" aria-label="'+a.n+' lower">&minus;</button>'+
   '<input type="range" id="s'+i+'" min="450" max="2400" step="10" value="1500" aria-label="'+a.n+' position">'+
   '<button class="nb" aria-label="'+a.n+' higher">+</button></div><div class="pre"></div>';
  $('axes').appendChild(d);
  var s=d.querySelector('input'),nb=d.querySelectorAll('.nb');
  s.oninput=function(){lastInput=Date.now();setSlider(i,this.value);sendAxis(i,this.value,false)};
  s.onchange=function(){sendAxis(i,this.value,true)};
  [-10,10].forEach(function(step,k){
    nb[k].onclick=function(){var v=clampUs(+s.value+step);lastInput=Date.now();setSlider(i,v);sendAxis(i,v,true)};
  });
  var pre=d.querySelector('.pre');
  a.p.forEach(function(p){
    var b=document.createElement('button');
    b.innerHTML=p[1]+'<small id="pv'+p[0]+'"></small>';
    b.onclick=function(){preset(i,p[0],p[1])};
    pre.appendChild(b);
  });
  if(a.dig){
    var g=document.createElement('button');
    g.id='dg';g.className='dig';g.setAttribute('data-on','0');g.textContent='Dig '+REPS+' times';
    g.onclick=function(){
      var on=g.getAttribute('data-on')==='1'?0:1;
      api('/dig?on='+on).then(function(){setTimeout(poll,150)});
    };
    d.appendChild(g);
  }
});

function hold(el,start,tick,end,ms){
  var t=null;
  function off(){if(t===null)return;clearInterval(t);t=null;el.classList.remove('on');end()}
  el.addEventListener('pointerdown',function(e){
    e.preventDefault();if(t!==null)return;
    try{el.setPointerCapture(e.pointerId)}catch(x){}
    el.classList.add('on');start();t=setInterval(tick,ms);
  });
  el.addEventListener('pointerup',off);
  el.addEventListener('pointercancel',off);
  el.addEventListener('contextmenu',function(e){e.preventDefault()});
  offs.push(off);
}
function releaseAll(){offs.forEach(function(f){f()})}
window.addEventListener('blur',releaseAll);
document.addEventListener('visibilitychange',function(){if(document.hidden)releaseAll()});

document.querySelectorAll('.pad button').forEach(function(b){
  var m=b.getAttribute('data-m');
  function go(){api('/d?m='+m+'&sp='+speed)}
  hold(b,go,go,function(){api('/d?m=s');setTimeout(function(){api('/d?m=s')},120)},250);
});
function pump(){api('/pump?on=1')}
hold($('water'),function(){$('wt').textContent='Watering';pump()},pump,
  function(){$('wt').textContent='Hold to water';api('/pump?on=0');setTimeout(function(){api('/pump?on=0')},150)},400);

$('sp').oninput=function(){speed=+this.value;$('spv').textContent=speed+'%'};
$('stop').onclick=function(){releaseAll();api('/stop').then(function(){toast('Everything stopped');setTimeout(poll,150)})};
$('home').onclick=function(){api('/home').then(function(){toast('Moving to home')})};
$('rs').onclick=function(){
  if(confirm('Reset all saved positions to the defaults?')){api('/reset').then(function(){poll(true);toast('Saved positions reset')})}
};
$('sm').onclick=function(){
  saveMode=!saveMode;document.body.classList.toggle('sv',saveMode);
  this.textContent=saveMode?'Save mode is on. Tap a preset to store the slider position.':'Save mode is off';
};
['t0','t1'].forEach(function(id,k){
  $(id).onclick=function(){
    $('t0').classList.toggle('on',k===0);$('t1').classList.toggle('on',k===1);
    $('p0').classList.toggle('hide',k!==0);$('p1').classList.toggle('hide',k!==1);
  };
});

function poll(force){
  api('/v').then(function(t){
    if(!t)return;
    var p=t.split('|'),tg=p[0].split(','),ps=p[1].split(','),dg=+p[3]||0;
    if(force===true||Date.now()-lastInput>1500)tg.forEach(function(v,i){setSlider(i,v)});
    ps.forEach(function(v,i){var e=$('pv'+i);if(e)e.textContent=v});
    var g=$('dg');
    g.setAttribute('data-on',dg>0?'1':'0');
    g.classList.toggle('on',dg>0);
    g.textContent=dg>0?'Digging '+dg+' of '+REPS+'. Tap to stop':'Dig '+REPS+' times';
    if(dg>0)setTimeout(poll,400);
  });
}
poll(true);setInterval(poll,1500);
</script>
</body></html>
)rawliteral";

// ---------- saved positions ----------
void loadPos() {
  for (int i = 0; i < P_COUNT; i++) pos[i] = POS_DEFAULT[i];
  prefs.begin("eco", false);
  size_t len = prefs.getBytesLength("pos");
  if (len == sizeof(pos)) prefs.getBytes("pos", pos, sizeof(pos));
  else if (len == OLD_P_COUNT * sizeof(int)) prefs.getBytes("pos", pos, OLD_P_COUNT * sizeof(int)); // keep old calibration, new dig values use defaults
  prefs.end();
}

void savePos() {
  prefs.begin("eco", false);
  prefs.putBytes("pos", pos, sizeof(pos));
  prefs.end();
}

void resetPos() {
  prefs.begin("eco", false);
  prefs.remove("pos");
  prefs.end();
  for (int i = 0; i < P_COUNT; i++) pos[i] = POS_DEFAULT[i];
}

// ---------- wheels ----------
void setMotor(int inA, int inB, int en, int pct) {
  pct = constrain(pct, -100, 100);
  digitalWrite(inA, pct > 0);
  digitalWrite(inB, pct < 0);
  ledcWrite(en, map(abs(pct), 0, 100, 0, 255));
}

void drive(int l, int r) {
  setMotor(IN1, IN2, ENA, l);
  setMotor(IN3, IN4, ENB, r);
  moving = (l != 0 || r != 0);
}

void driveCmd(char k, int sp) {
  if (sp > 0) speedPct = constrain(sp, 20, 100);
  switch (k) {
    case 'f': drive(speedPct, speedPct); break;
    case 'b': drive(-speedPct, -speedPct); break;
    case 'l': drive(-speedPct, speedPct); break;
    case 'r': drive(speedPct, -speedPct); break;
    default:  drive(0, 0); break;
  }
  if (moving) driveSeen = millis();
}

// ---------- pump ----------
void pumpSet(bool on) {
  if (!on) pumpOff = 0;
  pumpOn = on;
  int duty = on ? map(PUMP_POWER, 0, 100, 0, 255) : 0;
  if (!PUMP_ACTIVE_HIGH) duty = 255 - duty;
  ledcWrite(PUMP_PIN, duty);
}

// ---------- servos ----------
void writeUs(int ch, int us) {
  pwm.setPWM(ch, 0, (uint32_t)us * 4096UL / 20000UL);
}

void runAxes() {
  if (millis() - lastSlew < 10) return;
  lastSlew = millis();
  for (int i = 0; i < AX_COUNT; i++) {
    Axis& a = ax[i];
    if (a.cur == a.target) continue;
    if (abs(a.target - a.cur) <= a.slew) a.cur = a.target;
    else a.cur += (a.target > a.cur) ? a.slew : -a.slew;
    writeUs(a.ch, a.cur);
  }
}

// ---------- dig routine ----------
void digStart() {
  digging = true;
  digRep = 0;
  digPhase = 0;
  ax[AX_DIG].target = pos[P_DIG_LEFT];
}

void digCancel(bool toCenter) {
  digging = false;
  if (toCenter) ax[AX_DIG].target = pos[P_DIG_CENTER];
}

void runDig() {
  if (!digging) return;
  Axis& a = ax[AX_DIG];
  if (a.cur != a.target) return;          // wait until the last swing finished
  if (digPhase == 0) {                    // reached left, now swing right
    a.target = pos[P_DIG_RIGHT];
    digPhase = 1;
  } else if (digPhase == 1) {             // reached right, one full rep done
    digRep++;
    if (digRep >= DIG_REPS) { a.target = pos[P_DIG_CENTER]; digPhase = 2; }
    else { a.target = pos[P_DIG_LEFT]; digPhase = 0; }
  } else {
    digging = false;                      // back at center
  }
}

void stopAll() {
  drive(0, 0);
  pumpSet(false);
  digging = false;
  for (int i = 0; i < AX_COUNT; i++) ax[i].target = ax[i].cur;
}

// ---------- web handlers ----------
void hDrive() {
  String m = server.arg("m");
  driveCmd(m.length() ? tolower(m[0]) : 's', server.arg("sp").toInt());
  server.send(200, "text/plain", "ok");
}

void hServo() {
  int a = server.arg("a").toInt();
  int us = constrain(server.arg("us").toInt(), US_MIN, US_MAX);
  if (a >= 0 && a < AX_COUNT) {
    if (a == AX_DIG) digging = false;     // manual control cancels the dig routine
    ax[a].target = us;
  }
  server.send(200, "text/plain", "ok");
}

void hGo() {
  int id = server.arg("id").toInt();
  if (id < 0 || id >= P_COUNT) { server.send(400, "text/plain", ""); return; }
  if (POS_AXIS[id] == AX_DIG) digging = false;
  ax[POS_AXIS[id]].target = pos[id];
  server.send(200, "text/plain", String(pos[id]));
}

void hSave() {
  int id = server.arg("id").toInt();
  int us = constrain(server.arg("us").toInt(), US_MIN, US_MAX);
  if (id >= 0 && id < P_COUNT) {
    if (POS_AXIS[id] == AX_DIG) digging = false;
    pos[id] = us;
    ax[POS_AXIS[id]].target = us;
    savePos();
  }
  server.send(200, "text/plain", "saved");
}

void hPump() {
  if (server.arg("on") == "1") { pumpSet(true); pumpOff = millis() + 1200; }
  else pumpSet(false);
  server.send(200, "text/plain", "ok");
}

void hDig() {
  if (server.arg("on") == "1") { if (!digging) digStart(); }
  else if (digging) digCancel(true);
  server.send(200, "text/plain", "ok");
}

void hHome() {
  digging = false;
  for (int i = 0; i < AX_COUNT; i++) ax[i].target = pos[HOME_POS[i]];
  server.send(200, "text/plain", "ok");
}

void hStatus() {
  String s = "";
  for (int i = 0; i < AX_COUNT; i++) { if (i) s += ","; s += String(ax[i].target); }
  s += "|";
  for (int i = 0; i < P_COUNT; i++) { if (i) s += ","; s += String(pos[i]); }
  s += pumpOn ? "|1" : "|0";
  s += "|";
  s += digging ? String(digRep + 1) : String(0);
  server.send(200, "text/plain", s);
}

void setup() {
  Serial.begin(115200);
  int dirPins[] = {IN1, IN2, IN3, IN4};
  for (int p : dirPins) pinMode(p, OUTPUT);
  ledcAttach(ENA, 1000, 8);
  ledcAttach(ENB, 1000, 8);
  ledcAttach(PUMP_PIN, 500, 8);
  pumpSet(false);
  drive(0, 0);

  loadPos();
  for (int i = 0; i < AX_COUNT; i++) ax[i].cur = ax[i].target = pos[HOME_POS[i]];

  Wire.begin(21, 22);
  pwm.begin();
  pwm.setOscillatorFrequency(27000000);
  pwm.setPWMFreq(50);
  for (int i = 0; i < AX_COUNT; i++) writeUs(ax[i].ch, ax[i].cur);

  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.println(WiFi.softAPIP());

  server.on("/", []() { server.send_P(200, "text/html; charset=utf-8", PAGE); });
  server.on("/d", hDrive);
  server.on("/s", hServo);
  server.on("/g", hGo);
  server.on("/save", hSave);
  server.on("/pump", hPump);
  server.on("/dig", hDig);
  server.on("/home", hHome);
  server.on("/stop", []() { stopAll(); server.send(200, "text/plain", "ok"); });
  server.on("/reset", []() { resetPos(); server.send(200, "text/plain", "reset"); });
  server.on("/hold", []() {   // freeze ONE axis where it is (website "Rotate arms" release)
    int a = server.arg("a").toInt();
    if (a >= 0 && a < AX_COUNT) {
      if (a == AX_DIG) digging = false;
      ax[a].target = ax[a].cur;
    }
    server.send(200, "text/plain", "ok");
  });
  server.on("/v", hStatus);
  // ---- Website compatibility (EcoPlanter website uses /p and /c?d=<letter>) ----
  server.enableCORS(true);   // Access-Control-Allow-Origin: * on every response

  // Connection check used by Settings > Connect
  server.on("/p", []() { server.send(200, "text/plain", "OK"); });

  // Joystick / buttons: f = forward, b = back, l = left, r = right, s = stop, w = water
  server.on("/c", []() {
    String d = server.arg("d");
    char k = d.length() ? tolower(d[0]) : 's';
    if (k == 'w') {
      pumpSet(true);
      pumpOff = millis() + 2500;   // water for 2.5 s, then auto-off
    } else {
      driveCmd(k, 0);              // keeps the current speed; dead-man timer stops wheels
    }
    server.send(200, "text/plain", "ok");
  });

  server.begin();
}

void loop() {
  server.handleClient();
  runAxes();
  runDig();
  if (pumpOn && pumpOff && millis() > pumpOff) pumpSet(false);   // dead-man: page stopped asking
  if (moving && millis() - driveSeen > 600) drive(0, 0);         // dead-man: page stopped asking
}