# EcoPlanter: Smart Automated Planting Robot

A website and an ESP32 firmware for the EcoPlanter robot. The website lets you drive the robot, move its arms, dig, seed and water, and it also has a Demo Mode so you can try everything without the robot.

- **Website:** plain HTML, CSS and JavaScript. No install, no build step, no internet needed.
- **Robot firmware:** an Arduino sketch for the ESP32. It creates its own Wi-Fi network and serves both a small control page and the commands the website uses.

---

## What is in this repository

```
EcoPlanter-Website-joystick/
  index.html                     The website
  styles.css                     Website styling
  app.js                         Website logic (Demo Mode + robot connection)
  assets/                        Images and icon used by the website
  firmware/
    EcoPlanter_Robot/
      EcoPlanter_Robot.ino       The robot firmware: open THIS in the Arduino IDE
  ArduinoIDE/
    arduino.cpp                  Same firmware code as a plain .cpp copy (see note below)
  v1/
    v1.ino                       Older firmware (buttons only). Not needed any more
  make_standalone.py             Builds one single-file copy of the website
  ESP32_HTTP_CORS_AND_SAFETY_PATCH.txt   Old notes, already included in the new firmware
  preview/                       Screenshots
  README.md                      This file
```

**Note:** `firmware/EcoPlanter_Robot/EcoPlanter_Robot.ino` and `ArduinoIDE/arduino.cpp` contain the same code. The Arduino IDE needs a `.ino` file inside a folder with the same name, so use the `.ino`. To avoid the two copies drifting apart, keep only one of them in the repository and always edit that one.

---

## Quick start

1. **Flash the robot.** Open `firmware/EcoPlanter_Robot/EcoPlanter_Robot.ino` in the Arduino IDE and upload it to the ESP32 (details in [Step 1](#step-1-flash-the-robot)).
2. **Join the robot's Wi-Fi.** On your phone or computer, connect to `EcoPlanter` (password `plant1234`).
3. **Open the website.** Open `index.html` in your browser.
4. **Connect.** Go to **Settings**, type `http://192.168.4.1`, and press **Connect**. The badge should say "Hardware connected".
5. **Drive.** Go to **Robot Controls**, choose **Manual**, and use the joystick and the arm panel.

No robot yet? Skip steps 1 to 4. The website works on its own in Demo Mode.

---

## Setup in detail

### What you need

- ESP32 board (the sketch targets a standard ESP32 dev board)
- L298N motor driver with the wheel motors
- PCA9685 16-channel servo driver with the arm servos
- Water pump on a MOSFET module (optional, not required to test the rest)
- A phone or computer with Wi-Fi

### Wiring used by the firmware

| Part | ESP32 pin |
| --- | --- |
| L298N IN1, IN2 (left motors) | GPIO 25, GPIO 4 |
| L298N IN3, IN4 (right motors) | GPIO 27, GPIO 14 |
| L298N ENA, ENB | GPIO 33, GPIO 32 (optional: if not wired, keep the L298N enable jumpers on and the wheels run at full speed) |
| Pump MOSFET module (IN) | GPIO 23 (active high) |
| PCA9685 SDA, SCL | GPIO 21, GPIO 22 |
| PCA9685 power | 3.3V and GND for the board's logic, separate servo power on its V+ terminal |

Servo channels on the PCA9685:

| Channel | Servo |
| --- | --- |
| 0 | Base (turns the tool head) |
| 2 | Shoulder (watering arm) |
| 3 | Elbow (watering arm) |
| 4 | Lift (raises and lowers the seeder) |
| 5 | Gate (covers the seed hole) |
| 8 | Dig lower |
| 9 | Dig |

If your servos are plugged into different channels, change the `CH_...` numbers near the top of the sketch before flashing.

### Step 1: Flash the robot

1. Install the **Arduino IDE**.
2. Add ESP32 support: in *Boards Manager* install **esp32 by Espressif Systems**, version **3.x** (the sketch needs 3.x).
3. Install the library **Adafruit PWM Servo Driver Library** from *Library Manager*. The other libraries (WiFi, WebServer, Wire, Preferences) come with the ESP32 package.
4. Open `firmware/EcoPlanter_Robot/EcoPlanter_Robot.ino`.
5. Choose your board (for example *ESP32 Dev Module*) and the right port, then press **Upload**.
6. Power the robot. It starts a Wi-Fi network:
   - Name: `EcoPlanter`
   - Password: `plant1234`
   - Address: `http://192.168.4.1`

You can change the name and password at the top of the sketch (`AP_SSID`, `AP_PASS`).

**Quick check:** join the `EcoPlanter` Wi-Fi and open `http://192.168.4.1/p` in a browser. It should show `OK`. If it does, the robot side is ready. Opening `http://192.168.4.1` shows the robot's own control page, which has a **Drive** tab and an **Arm** tab.

### Step 2: Open the website

The simplest way is to double-click `index.html`.

If your browser blocks something when opening the file directly, run a small local server in the project folder instead:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

Important rules for a working connection:

- Use **`http://`**, not `https://`. Browsers block secure pages from talking to the robot.
- The device running the website must be connected to the **`EcoPlanter` Wi-Fi** while you drive.
- Your phone may warn that the Wi-Fi has no internet. Choose to stay connected.

**Using it on a phone:** run `python make_standalone.py` once on your computer. It creates a single file, `EcoPlanter_Website.html`, with the images built in. Copy that file to your phone and open it in the browser.

### Step 3: Connect the website to the robot

1. Join the `EcoPlanter` Wi-Fi.
2. Open the website and go to **Settings**.
3. Under the connection card, enter `http://192.168.4.1` and press **Connect**.
4. The sidebar changes to "ESP32 connected". Press **Return to demo** any time to go back to Demo Mode.

---

## Using the website

| Page | What it does |
| --- | --- |
| Home | Introduction to the project |
| Dashboard | Overview: soil moisture, seed count, pump status, battery, activity (simulated unless noted below) |
| Robot Controls | Drive, arm, dig, seed and water controls |
| Planting Records | Activity log with CSV export |
| Settings | Planting preferences and the robot connection |
| About | About the project |

### Driving

1. Go to **Robot Controls** and choose **Manual** under *Operating mode*. Controls that move the robot only work in Manual mode.
2. Drag the on-screen **joystick**: up is forward, down is back, sideways turns. Let go to stop. On a computer you can also hold the arrow keys.
3. **Pivot left / Pivot right** give a short turn on the spot.

The robot supports four directions (forward, back, left, right). Pushing the joystick farther does not change the speed.

### Arm and digger controls (new)

The **Arm & digger controls** panel on the Robot Controls page copies everything from the robot's own Arm tab:

| Control | What it does |
| --- | --- |
| Seven sliders: Base, Shoulder, Elbow, Lift, Gate, Dig lower, Dig | Drag to move that servo. The `-` and `+` buttons move it in small steps. The number is the servo pulse width. |
| Preset buttons (for example Left, Center, Right, Home, Water, Up, Down, Open, Closed) | Move the servo to a saved position. The small number under each name is the saved value. |
| **Save mode** | Turn it on, move a slider to the position you like, then tap a preset. That position is stored **on the robot** and survives a restart. |
| **Home all** | Moves every servo to its home position. |
| **Reset saved** | Puts all presets back to the factory defaults (asks you to confirm). |
| **Dig 8 times** | Runs the dig routine: swings left and right 8 times, then returns to center. Tap again to stop. |
| **Stop all** | Stops the wheels, pump, dig routine and all servos right where they are. |
| **Hold to water** | The pump runs while you hold the button and stops when you let go. |

The panel stays in sync with the robot: it reads the robot's state every second or two, so sliders and saved values always match what the robot is really doing. The small badge in the panel's corner shows **Demo**, **Live** or **No signal**.

### Other buttons that now work with the robot

| Button | What happens |
| --- | --- |
| Watering arm > Aim at target | Base turns left, shoulder and elbow move to their water positions |
| Watering arm > Water spot | Pump runs for 2.5 seconds |
| Seed-dropper arm > Aim at target | Base turns right and the lift goes down |
| Seed-dropper arm > Drop seed | Gate opens, then closes after 0.9 seconds, and the seed counter goes up |
| Rotate arms (hold) | The base turns while you hold the button and freezes when you let go |
| Stop current action / Emergency stop | Sends the full stop command to the robot |

The **Soil moisture probe** buttons do nothing on the real robot yet, because there is no probe hardware or firmware for it.

### Demo Mode

When no robot is connected, everything runs on simulated data so you can try the website anywhere:

- The planting cycle, moisture, battery and records are simulated.
- The arm panel works too, using the default positions. It never touches real hardware.
- The camera picture is a still illustration, not a live video.
- Settings and records are saved in your browser (`localStorage`).

Things to try: Dashboard > *Start automatic cycle*, Settings > *Demo environment* (dry, optimal or wet soil), Records > *Export CSV*, the moon icon for dark mode.

---

## For developers: robot commands

The website talks to the ESP32 with simple HTTP GET requests. The firmware allows requests from any website (CORS) so the browser accepts the replies.

| Route | Purpose |
| --- | --- |
| `/p` | Connection check, replies `OK` |
| `/c?d=f\|b\|l\|r\|s\|w` | Drive (forward, back, left, right, stop) or water for 2.5 s (`w`) |
| `/d?m=f\|b\|l\|r\|s&sp=20-100` | Drive with a speed value (used by the robot's own page) |
| `/s?a=<0-6>&us=<450-2400>` | Move one servo to a pulse width |
| `/g?id=<0-15>` | Go to a saved preset, replies with its value |
| `/save?id=<0-15>&us=` | Store a preset |
| `/dig?on=1\|0` | Start or stop the dig routine |
| `/home` | All servos to home |
| `/reset` | Reset saved presets to defaults |
| `/hold?a=<0-6>` | Freeze one servo where it is |
| `/pump?on=1\|0` | Pump on or off (turns itself off if the requests stop) |
| `/stop` | Stop wheels, pump, dig routine and servos |
| `/v` | Status: servo targets, saved presets, pump state, dig count |

Servo numbers (`a`): 0 Base, 1 Shoulder, 2 Elbow, 3 Lift, 4 Gate, 5 Dig lower, 6 Dig.

Where to change things:

- Website behaviour and robot commands: `app.js`
- Default positions, servo speeds and dig count: the top of the firmware (`POS_DEFAULT`, `SLEW_US`, `DIG_REPS`). If you change `DIG_REPS`, change `ARM_REPS` in `app.js` to match.

---

## Safety

- The wheels stop by themselves if the robot stops receiving drive commands (for example if Wi-Fi drops), and the pump turns itself off if its commands stop. Still, **keep a physical power switch within reach** whenever the robot moves.
- The website's Emergency stop also locks the website's own controls until you reset them in Settings. It is not a replacement for a hardware emergency stop.
- Servos move on their own once told to. Keep hands and cables clear of the arms while testing.

---

## Troubleshooting

| Problem | What to check |
| --- | --- |
| "Connection failed" when pressing Connect | Make sure you are on the `EcoPlanter` Wi-Fi, the address is exactly `http://192.168.4.1`, and `http://192.168.4.1/p` shows `OK` in a browser. |
| `/p` shows "not found" | You flashed an older sketch. Flash `firmware/EcoPlanter_Robot/EcoPlanter_Robot.ino` from this repository. |
| Works in a browser tab but not from the website | The website must be opened with `http://` or as a file, not `https://`. |
| Badge shows "No signal" or commands stop working | The phone or computer left the robot's Wi-Fi. Rejoin `EcoPlanter` and keep it connected. |
| Arm controls are greyed out | Choose **Manual** in *Operating mode*, stop any running cycle, and reset Demo Mode if you used Emergency stop. |
| Robot turns but does not reverse | Check the L298N wiring: the left motors need IN1 and IN2 on GPIO 25 and GPIO 4. |
| A servo moves the wrong way or too far | Adjust that preset using **Save mode**, or change `POS_DEFAULT` in the firmware. |
| Pump does not run | Check the MOSFET module wiring on GPIO 23 and the pump's own power supply. |

---

## Good to know

- This is a prototype. The camera image, soil moisture, battery and planting records on the Dashboard are simulated until you add real sensors and a live camera feed.
- The seed counter counts the seed commands you send. It does not detect whether a seed actually dropped.
- The website needs no installation and no internet, because everything it uses is included in the folder.