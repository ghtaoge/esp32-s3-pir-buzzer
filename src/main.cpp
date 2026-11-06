#include <Arduino.h>
#include "driver/gpio.h"
#include "motion_alarm.h"

namespace {
constexpr uint8_t PirPin = 3;
constexpr uint8_t BuzzerPin = 7;
constexpr uint32_t ToneHz = 2000;
pir::MotionAlarm detector;
bool sounding = false;
bool pwmReady = false;
bool outputReadbackReady = false;
bool manualMode = false;
bool testRunning = false;
uint32_t testStartedAt = 0;

void printStatus(bool rawHigh) {
  Serial.printf("PIR=%s armed=%u buzzer=%s events=%lu PWM=%s mode=%s\n",
      rawHigh ? "HIGH" : "LOW",
      static_cast<unsigned>(detector.armed), sounding ? "ON" : "OFF",
      static_cast<unsigned long>(detector.triggers), pwmReady ? "OK" : "ERROR",
      manualMode ? "MANUAL_TEST" : "AUTO");
}

void inspectBuzzerOutput() {
  if (!outputReadbackReady) {
    Serial.println("GPIO7 readback unavailable");
    return;
  }
  uint32_t highSamples = 0, lowSamples = 0;
  const uint32_t started = micros();
  // Sample the pad input, rather than reporting only the requested PWM state.
  while (static_cast<uint32_t>(micros() - started) < 3000) {
    if (gpio_get_level(static_cast<gpio_num_t>(BuzzerPin))) ++highSamples;
    else ++lowSamples;
  }
  Serial.printf("GPIO7 actual: HIGH_samples=%lu LOW_samples=%lu expected=%s\n",
      static_cast<unsigned long>(highSamples), static_cast<unsigned long>(lowSamples),
      sounding ? "2000Hz_PWM" : "LOW");
}
}

void setup() {
  // Prevent an unplugged/poorly connected OUT wire from floating high.
  pinMode(PirPin, INPUT_PULLDOWN);
  pinMode(BuzzerPin, OUTPUT);
  digitalWrite(BuzzerPin, LOW);
  Serial.begin(115200);
  pwmReady = ledcAttach(BuzzerPin, ToneHz, 8);
  if (pwmReady) ledcWrite(BuzzerPin, 0);
  else Serial.println("ERROR: cannot initialize buzzer PWM on GPIO7");
  // Enable pad input readback without changing its LEDC output routing.
  outputReadbackReady = gpio_input_enable(static_cast<gpio_num_t>(BuzzerPin)) == ESP_OK;
  Serial.println("Ready immediately: PIR GPIO3 -> passive buzzer GPIO7.");
  Serial.println("Each trigger beeps once for 2 s; held HIGH cannot repeat.");
  Serial.println("PIR power-on settling can cause false triggers.");
  Serial.println("Serial: t = isolated 2s buzzer test, a = return to AUTO, ? = status and GPIO7 readback.");
}

void loop() {
  const uint32_t now = millis();
  const bool rawHigh = digitalRead(PirPin) == HIGH;
  bool requested = false;
  while (Serial.available()) {
    const int command = Serial.read();
    if (command == '?') requested = true;
    else if (command == 't' || command == 'T') {
      manualMode = true;
      testRunning = true;
      testStartedAt = now;
      requested = true;
      Serial.println("TEST: buzzer GPIO7 at 2000 Hz for 2s; automatic sound paused until 'a'.");
    } else if (command == 'a' || command == 'A') {
      manualMode = false;
      testRunning = false;
      requested = true;
      Serial.println("AUTO: motion-triggered buzzer resumed.");
    }
  }
  if (testRunning && static_cast<uint32_t>(now - testStartedAt) >= pir::BeepMs) {
    testRunning = false;
    Serial.println("TEST FINISHED: buzzer output stopped.");
  }
  const bool wasArmed = detector.armed;
  detector.tick(now, rawHigh);

  const bool wanted = pwmReady && (manualMode ? testRunning : detector.sounding);
  const bool soundChanged = wanted != sounding;
  if (soundChanged) {
    if (wanted) {
      if (!ledcWriteTone(BuzzerPin, ToneHz)) {
        ledcWrite(BuzzerPin, 0);
        pwmReady = false;
        Serial.println("ERROR: cannot start buzzer PWM");
      } else sounding = true;
    } else {
      ledcWrite(BuzzerPin, 0);
      sounding = false;
    }
  }
  static uint32_t loggedAt = 0;
  if (requested || soundChanged || detector.armed != wasArmed ||
      static_cast<uint32_t>(now - loggedAt) >= 2000) {
    printStatus(rawHigh);
    if (requested || soundChanged) inspectBuzzerOutput();
    loggedAt = now;
  }
  delay(2);
}
