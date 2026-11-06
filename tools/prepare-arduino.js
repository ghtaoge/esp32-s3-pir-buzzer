const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const header = fs.readFileSync(path.join(root, 'include/motion_alarm.h'), 'utf8')
  .replace(/^#pragma once\s*/m, '');
const firmware = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8')
  .replace('#include "motion_alarm.h"', header.trimEnd());
const sketch = path.join(root, 'arduino', 'pir_buzzer', 'pir_buzzer.ino');
fs.mkdirSync(path.dirname(sketch), { recursive: true });
fs.writeFileSync(sketch, '// Generated from src/main.cpp. Requires Arduino-ESP32 3.x.\n' + firmware);
console.log(sketch);
