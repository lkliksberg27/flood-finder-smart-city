# FloodFinder Carrier V2 — FINAL Component Placement & Net Map

**Board:** 65mm × 45mm, 2-layer, 1.6mm thick
**Origin:** bottom-left corner of board (0, 0)
**All dimensions in millimeters**

## ⚠️ CRITICAL CORRECTION

Earlier spec assumed I2C via GPIO17/GPIO18 through the headers. **VERIFIED from the Heltec V4 official pinmap: GPIO17 and GPIO18 are NOT on the external side headers.** They are internal-only, wired to the onboard OLED.

**Fix applied:** External I2C now runs on **GPIO33 (SDA)** and **GPIO34 (SCL)** — both exposed on Heltec V4's J2 right-side header. BMP390 and MPU6050 share this new external bus. The onboard OLED keeps its dedicated internal bus.

Firmware change already applied to `flood_sensor.ino`:
```cpp
Wire.begin(33, 34);  // SDA=GPIO33, SCL=GPIO34
```

## Heltec V4 Header Pin Map (from official pinmap)

**Header J3 (LEFT side, as Heltec labels it)** — counting from USB-C end:
| Pin | Signal | Notes |
|-----|--------|-------|
| — | GND, 3V3, VBat_Read at one end |
| — | TOUCH7/ADC1_CH6/**GPIO7** | encoder SW |
| — | TOUCH6/ADC1_CH5/**GPIO6** | encoder DT |
| — | TOUCH5/ADC1_CH4/**GPIO5** | encoder CLK |
| — | TOUCH4/ADC1_CH3/**GPIO4** | unused |
| — | TOUCH3/ADC1_CH2/**GPIO3** | ultrasonic ECHO |
| — | TOUCH2/ADC1_CH1/**GPIO2** | ultrasonic TRIG |
| — | TOUCH1/**GPIO1** | battery ADC |
| — | GPS pins, MTDI, MTDO, etc. |

**Header J2 (RIGHT side, as Heltec labels it):**
| Pin | Signal | Notes |
|-----|--------|-------|
| — | 5V, 3V3, GND at ends |
| — | **GPIO19** (U1RST) |
| — | **GPIO20** (U1CTS) |
| — | **GPIO21** (OLED_RST) |
| — | **GPIO26** (CLK_OUT2) |
| — | **GPIO47, GPIO48** (FSPI lines) |
| — | **GPIO33** | ← **USE FOR SDA** |
| — | **GPIO34** | ← **USE FOR SCL** |
| — | GPIO35, GPIO37, GPIO38, RST, GPIO43, GPIO44 |

**⚠ I can't give you exact physical pin numbers (1-18) on J2 for GPIO33/GPIO34 without the schematic PDF.** When designing the PCB, open the Heltec V4 schematic at [resource.heltec.cn/download/WiFi_LoRa_32_V4/Schematic](https://resource.heltec.cn/download/WiFi_LoRa_32_V4/Schematic) to get the exact pin numbers, then route accordingly.

## Board Layout — top view

```
     0                                                               65
  45 ┌─────────────────────────────────────────────────────────────┐
     │ H3●                                                      ●H4│
     │                                                             │
     │         ┌──18-pin female socket J2_sock (Heltec right)─┐    │
  34 │     ────●──●──●──●──●──●──●──●──●──●──●──●──●──●●●●●──     │
     │                                    ↑      ↑                 │
     │                          GPIO33(SDA)  GPIO34(SCL)           │
     │                                                             │
     │                  [U2]    [U1]    I2C pull-ups               │
     │     ┌──J3     [MPU6050] [BMP390]  R1  R2                   ◀━━┓
     │     │ 4-pin                                                 │ ┃
  23 │     │ JST-XH  C3 C4 C5  C1 C2                         ┏━━SW1┃
     │     │ vert                                            ┃  EC11│
     │     │ TH                                              ┃  TH  │
     │     │                                                 ┃      │
     │     └──                                               ┃     │
     │                                                       ┃      │
  11 │     ────●──●──●──●──●──●──●──●──●──●──●──●──●──●●●●●──     │
     │         └──18-pin female socket J1_sock (Heltec left)─┘     │
     │                                                             │
     │ H1●                                                      ●H2│
   0 └─────────────────────────────────────────────────────────────┘
```

## Exact Component Coordinates

### Board-mounted connectors & socket headers

| Ref | Part | Center X | Center Y | Rotation | Notes |
|-----|------|----------|----------|----------|-------|
| J1_sock | 1x18 female socket, 2.54mm | 32.5 | 11.07 | 0° | Receives Heltec V4 LEFT header |
| J2_sock | 1x18 female socket, 2.54mm | 32.5 | 33.93 | 0° | Receives Heltec V4 RIGHT header |
| J3 | JST-XH 4-pin vertical TH | 4.5 | 22.5 | 90° | Left edge, cable exits left |
| SW1 | EC11 rotary encoder TH | 58 | 22.5 | 0° | Right edge, knob points right |

### SMD ICs (placed between headers, under V4)

| Ref | Part | Center X | Center Y | LCSC |
|-----|------|----------|----------|------|
| U1 | BMP390 (LGA-10) | 45 | 22.5 | C5124834 |
| U2 | MPU-6050 (QFN-24) | 35 | 22.5 | C24112 |

### Decoupling capacitors (0402, within 1mm of power pin)

| Ref | Value | X | Y | Function |
|-----|-------|---|---|----------|
| C1 | 100nF 0402 | 46 | 20.5 | BMP390 VDD |
| C2 | 100nF 0402 | 46 | 24.5 | BMP390 VDDIO |
| C3 | 100nF 0402 | 33 | 25 | MPU-6050 VDD |
| C4 | 100nF 0402 | 33 | 20 | MPU-6050 VLOGIC |
| C5 | 10nF 0402 | 37.5 | 22.5 | MPU-6050 REGOUT (MANDATORY) |

### I2C pull-ups (0402)

| Ref | Value | X | Y | Net |
|-----|-------|---|---|-----|
| R1 | 4.7K 0402 | 48 | 25 | SDA (GPIO33) to 3V3 |
| R2 | 4.7K 0402 | 48 | 22 | SCL (GPIO34) to 3V3 |

### Mounting holes (M3)

| Ref | X | Y | Drill |
|-----|---|---|-------|
| H1 | 3 | 3 | 3.2mm |
| H2 | 62 | 3 | 3.2mm |
| H3 | 3 | 42 | 3.2mm |
| H4 | 62 | 42 | 3.2mm |

## Net List (Updated for GPIO33/34 I2C)

| Net | From Heltec V4 pin | To |
|-----|-------|-----|
| **+3V3** | J3 3V3 pin OR J2 3V3 pin | U1 VDD, U1 VDDIO, U1 CSB, U1 SDO, U2 VDD, U2 VLOGIC, R1, R2, J3 VCC |
| **GND** | Any GND pin (multiple available) | U1 VSS (×3), U2 GND + EP, U2 CLKIN, U2 FSYNC, U2 AD0, all cap returns, J3 GND, SW1 C + E, all mounting holes |
| **SDA** | **J2 pin for GPIO33** | U1 SDI (pin 4), U2 SDA (pin 24), R1 (pull-up to 3V3) |
| **SCL** | **J2 pin for GPIO34** | U1 SCK (pin 2), U2 SCL (pin 23), R2 (pull-up to 3V3) |
| **TRIG** | J3 left header, GPIO2 position | J3 ultrasonic pin 2 |
| **ECHO** | J3 left header, GPIO3 position | J3 ultrasonic pin 3 |
| **ENC_CLK** | J3 left header, GPIO5 position | SW1 pin A |
| **ENC_DT** | J3 left header, GPIO6 position | SW1 pin B |
| **ENC_SW** | J3 left header, GPIO7 position | SW1 pin D |

## Routing Rules

- Power traces: 0.5mm
- I2C traces: 0.3mm
- GPIO signals: 0.25mm
- Bottom layer: solid GND pour
- Via next to every decoupling cap GND pad
- MPU6050 thermal pad: 4+ vias to ground plane

## What to do next

1. **Firmware is already updated** to use Wire.begin(33, 34) — committed in repo
2. **When designing the PCB**, either:
   - Take this file + the Heltec V4 schematic to a Fiverr PCB designer ($30-80)
   - Or update Flux's project with the corrected GPIO assignments
   - Or design in KiCad/EasyEDA from scratch — the coordinates are all here
3. **Export Gerbers** → JLCPCB → order 30 boards

## Bill of Materials (for JLCPCB assembly)

| Ref | Part | LCSC | Qty |
|-----|------|------|-----|
| U1 | BMP390 | C5124834 | 1 |
| U2 | MPU-6050 | C24112 | 1 |
| C1-C4 | 100nF 0402 | C1525 | 4 |
| C5 | 10nF 0402 | C15195 | 1 |
| R1-R2 | 4.7K 0402 | C25900 | 2 |

Through-hole (self-solder): 2× 1x18 female pin sockets, 1× JST-XH 4-pin, 1× EC11 encoder
