#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

const char* AP_SSID = "EcoPlanter";
const char* AP_PASS = "plant1234";

// L298N wheels
const int IN1 = 25, IN2 = 4, ENA = 33;
const int IN3 = 27, IN4 = 14, ENB = 32;
const int SPEED = 60;

// Existing pump configuration (unchanged)
const int PUMP_PIN = 23;
const bool PUMP_ACTIVE_HIGH = true;
const int PUMP_MS = 2500;

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);
const int SLEW_US = 12;
const int PAUSE_MS = 1000;

// ---- REVERSED ARM AXES ----
// Channel 0: Base
// Channel 1: Lower arm / shoulder
// Channel 2: Upper arm / elbow
const bool FLIP_BASE     = true;
const bool FLIP_SHOULDER = true;
const bool FLIP_ELBOW    = true;

const bool FLIP[3] = {
  FLIP_BASE,
  FLIP_SHOULDER,
  FLIP_ELBOW
};

// Axis 0: Base, channel 0
const int BASE_CENTER = 1500;
const int BASE_SWEEP = 800;
const int BASE_LEFT = BASE_CENTER - BASE_SWEEP;
const int BASE_RIGHT = BASE_CENTER + BASE_SWEEP;

// Axis 1: Lower arm / shoulder, channel 1
const int SHOULDER_HOME = 1500;
const int SHOULDER_OUT = 1900;

// Axis 2: Upper arm / elbow, channel 2
const int ELBOW_UP = 1500;
const int ELBOW_DOWN = 1800;

struct Axis {
  int ch;
  int cur;
  int target;
};

Axis ax[3] = {
  {0, BASE_CENTER, BASE_CENTER},
  {1, SHOULDER_HOME, SHOULDER_HOME},
  {2, ELBOW_UP, ELBOW_UP}
};

enum StepType {
  T_MOVE,
  T_MOVE_NOWAIT,
  T_PAUSE,
  T_PUMP
};

struct Step {
  StepType t;
  int a;
  int v;
};

const Step SWEEP[] = {
  {T_MOVE, 0, BASE_RIGHT},
  {T_PAUSE, 0, PAUSE_MS},
  {T_MOVE, 0, BASE_CENTER},
  {T_MOVE, 0, BASE_LEFT},
  {T_PAUSE, 0, PAUSE_MS},
  {T_MOVE, 0, BASE_CENTER}
};

const Step WATERSEQ[] = {
  {T_MOVE, 0, BASE_LEFT},
  {T_MOVE_NOWAIT, 1, SHOULDER_OUT},
  {T_MOVE, 2, ELBOW_DOWN},
  {T_PAUSE, 0, 300},
  {T_PUMP, 0, PUMP_MS},
  {T_MOVE_NOWAIT, 2, ELBOW_UP},
  {T_MOVE, 1, SHOULDER_HOME},
  {T_MOVE, 0, BASE_CENTER}
};

const Step HOMESEQ[] = {
  {T_MOVE, 2, ELBOW_UP},
  {T_MOVE, 1, SHOULDER_HOME},
  {T_MOVE, 0, BASE_CENTER}
};

const Step* seqPtr = nullptr;
int seqLen = 0;
int seqIdx = 0;
bool stepStarted = false;
unsigned long stepT = 0;
unsigned long lastSlew = 0;

WebServer server(80);
unsigned long lastSeen = 0;
unsigned long lastWheelCmd = 0;
bool moving = false;

void addCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Cache-Control", "no-store");
}

const char PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:sans-serif;text-align:center;margin:0;padding:16px}
.g{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;max-width:420px;margin:0 auto 16px}
button{height:72px;font-size:26px;border:0;border-radius:16px;background:#2e7d32;color:#fff}
.s{background:#c62828}
.t{background:#1565c0;font-size:20px}
.a{background:#6a1b9a;font-size:20px;width:100%;max-width:420px;margin-bottom:16px}
</style>
</head>
<body>

<h2>EcoPlanter</h2>

<div class="g">
<span></span><button onclick="c('f')">F</button><span></span>
<button onclick="c('l')">L</button>
<button class="s" onclick="c('s')">S</button>
<button onclick="c('r')">R</button>
<span></span><button onclick="c('b')">B</button><span></span>
</div>

<h3>Base</h3>
<div class="g">
<button class="t" onclick="c('q')">&#9664; Left</button>
<button class="t" onclick="c('c')">Middle</button>
<button class="t" onclick="c('e')">Right &#9654;</button>
</div>

<button class="a" onclick="c('a')">Auto sweep</button>

<h3>Arm</h3>
<div class="g">
<button class="t" onclick="c('w')">Water</button>
<button class="t" onclick="c('h')">Home</button>
<span></span>
</div>

<h3>Manual arm</h3>

<p>Shoulder <span id="sv">1500</span></p>
<input type="range" id="sh" min="600" max="2300"
step="10" value="1500" style="width:90%"
oninput="document.getElementById('sv').textContent=this.value"
onchange="sl(1,this.value)">

<p>Elbow <span id="ev">1500</span></p>
<input type="range" id="el" min="600" max="2300"
step="10" value="1500" style="width:90%"
oninput="document.getElementById('ev').textContent=this.value"
onchange="sl(2,this.value)">

<script>
function c(x){fetch('/c?d='+x)}
function sl(a,v){fetch('/s?a='+a+'&us='+v)}

fetch('/v').then(function(r){return r.text()})
.then(function(t){
  var p=t.split(',');
  document.getElementById('sh').value=p[0];
  document.getElementById('sv').textContent=p[0];
  document.getElementById('el').value=p[1];
  document.getElementById('ev').textContent=p[1];
});

setInterval(function(){fetch('/p')},1000);
</script>

</body>
</html>
)rawliteral";

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

void pumpSet(bool on) {
  digitalWrite(
    PUMP_PIN,
    (on == PUMP_ACTIVE_HIGH) ? HIGH : LOW
  );
}

// Updated servo direction mapping
void writeUs(int ch, int us) {
  if (ch >= 0 && ch < 3 && FLIP[ch]) {
    us = 3000 - us;
  }

  us = constrain(us, 500, 2500);

  pwm.setPWM(
    ch,
    0,
    (uint32_t)us * 4096UL / 20000UL
  );
}

void runAxes() {
  if (millis() - lastSlew < 10) return;

  lastSlew = millis();

  for (int i = 0; i < 3; i++) {
    Axis& a = ax[i];

    if (a.cur == a.target) continue;

    if (abs(a.target - a.cur) <= SLEW_US) {
      a.cur = a.target;
    } else {
      a.cur += (a.target > a.cur)
                 ? SLEW_US
                 : -SLEW_US;
    }

    writeUs(a.ch, a.cur);
  }
}

bool busy() {
  if (seqPtr) return true;

  for (int i = 0; i < 3; i++) {
    if (ax[i].cur != ax[i].target) return true;
  }

  return false;
}

void runSequence() {
  if (!seqPtr) return;

  if (seqIdx >= seqLen) {
    seqPtr = nullptr;
    pumpSet(false);
    return;
  }

  const Step& s = seqPtr[seqIdx];

  if (!stepStarted) {
    stepStarted = true;
    stepT = millis();

    if (s.t == T_MOVE || s.t == T_MOVE_NOWAIT) {
      ax[s.a].target = s.v;
    }

    if (s.t == T_PUMP) {
      pumpSet(true);
    }
  }

  bool done;

  if (s.t == T_MOVE) {
    done = (ax[s.a].cur == ax[s.a].target);
  } else if (s.t == T_MOVE_NOWAIT) {
    done = true;
  } else {
    done = (millis() - stepT >= (unsigned long)s.v);
  }

  if (done) {
    if (s.t == T_PUMP) {
      pumpSet(false);
    }

    seqIdx++;
    stepStarted = false;
  }
}

void startSeq(const Step* p, int n) {
  drive(0, 0);

  seqPtr = p;
  seqLen = n;
  seqIdx = 0;
  stepStarted = false;
}

#define START(s) startSeq(s, sizeof(s) / sizeof(s[0]))

void moveTo(int a, int us) {
  drive(0, 0);

  seqPtr = nullptr;
  pumpSet(false);

  ax[a].target = us;
}

void stopAll() {
  drive(0, 0);

  seqPtr = nullptr;
  pumpSet(false);

  for (int i = 0; i < 3; i++) {
    ax[i].target = ax[i].cur;
  }
}

void handle(char c) {
  char k = tolower(c);

  bool wheelCmd =
    (k == 'f' || k == 'b' || k == 'l' || k == 'r');

  if (wheelCmd) {
    lastWheelCmd = millis();
  }

  if (wheelCmd && busy()) return;

  switch (k) {
    case 'f':
      drive(SPEED, SPEED);
      break;

    case 'b':
      drive(-SPEED, -SPEED);
      break;

    case 'l':
      drive(-SPEED, SPEED);
      break;

    case 'r':
      drive(SPEED, -SPEED);
      break;

    case 's':
      stopAll();
      break;

    case 'q':
      moveTo(0, BASE_LEFT);
      break;

    case 'e':
      moveTo(0, BASE_RIGHT);
      break;

    case 'c':
      moveTo(0, BASE_CENTER);
      break;

    case 'a':
      START(SWEEP);
      break;

    case 'w':
      START(WATERSEQ);
      break;

    case 'h':
      START(HOMESEQ);
      break;
  }
}

void setup() {
  Serial.begin(115200);

  int dirPins[] = {IN1, IN2, IN3, IN4};

  for (int p : dirPins) {
    pinMode(p, OUTPUT);
  }

  pinMode(PUMP_PIN, OUTPUT);
  pumpSet(false);

  ledcAttach(ENA, 1000, 8);
  ledcAttach(ENB, 1000, 8);

  drive(0, 0);

  Wire.begin(21, 22);

  pwm.begin();
  pwm.setOscillatorFrequency(27000000);
  pwm.setPWMFreq(50);

  for (int i = 0; i < 3; i++) {
    writeUs(ax[i].ch, ax[i].cur);
  }

  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.println(WiFi.softAPIP());

  server.on("/", []() {
    lastSeen = millis();
    addCorsHeaders();
    server.send_P(200, "text/html", PAGE);
  });

  server.on("/c", HTTP_OPTIONS, []() {
    addCorsHeaders();
    server.send(204, "text/plain", "");
  });

  server.on("/c", []() {
    lastSeen = millis();
    addCorsHeaders();

    String d = server.arg("d");

    if (d.length()) {
      if (d[0] == 'f' || d[0] == 'b' || d[0] == 'l' || d[0] == 'r') {
        lastWheelCmd = millis();
      }
      handle(d[0]);
    }

    server.send(200, "text/plain", "ok");
  });

  server.on("/v", HTTP_OPTIONS, []() {
    addCorsHeaders();
    server.send(204, "text/plain", "");
  });

  server.on("/v", []() {
    lastSeen = millis();
    addCorsHeaders();

    server.send(
      200,
      "text/plain",
      String(ax[1].target) + "," + String(ax[2].target)
    );
  });

  server.on("/p", HTTP_OPTIONS, []() {
    addCorsHeaders();
    server.send(204, "text/plain", "");
  });

  server.on("/p", []() {
    lastSeen = millis();
    addCorsHeaders();
    server.send(200, "text/plain", "ok");
  });

  server.on("/s", HTTP_OPTIONS, []() {
    addCorsHeaders();
    server.send(204, "text/plain", "");
  });

  server.on("/s", []() {
    lastSeen = millis();
    addCorsHeaders();

    int a = server.arg("a").toInt();
    int us = constrain(server.arg("us").toInt(), 600, 2300);

    if (a == 1 || a == 2) {
      drive(0, 0);

      seqPtr = nullptr;
      pumpSet(false);

      ax[a].target = us;
    }

    server.send(200, "text/plain", "ok");
  });

  server.begin();
}

void loop() {
  server.handleClient();

  runAxes();
  runSequence();

  while (Serial.available()) {
    handle(Serial.read());
  }

  if (moving && millis() - lastWheelCmd > 400) {
    drive(0, 0);
  }
}
