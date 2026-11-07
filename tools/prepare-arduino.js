const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const headerNames = fs.readdirSync(path.join(root, 'include')).filter(name => name.endsWith('.h'));
const firmware = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8');
const sketch = path.join(root, 'arduino', 'pir_buzzer', 'pir_buzzer.ino');
fs.mkdirSync(path.dirname(sketch), { recursive: true });
// Compile the implementation as C++ so Arduino's automatic prototype insertion
// cannot move declarations out of namespaces or ahead of custom protocol types.
fs.writeFileSync(sketch, '// Generated project. Requires Arduino-ESP32 3.x and ArduinoJson 7.4.2.\n// setup() and loop() are compiled from sentinel_firmware.cpp in this folder.\n');
fs.writeFileSync(path.join(path.dirname(sketch), 'sentinel_firmware.cpp'), firmware);
for (const name of headerNames) fs.copyFileSync(path.join(root, 'include', name), path.join(path.dirname(sketch), name));
console.log(sketch);
