# Sentinel protocol v1

The USB CDC serial and BLE transports carry the same UTF-8 NDJSON messages.
Each message ends with LF. CR before LF is ignored. A frame is at most 2048
bytes including LF. Oversize input is discarded through LF, never truncated
into a valid command. BLE RX writes and TX notifications use chunks of at
most 20 bytes, independent of negotiated MTU. Commands have a positive integer
`id`; clients serialize requests and wait for the matching response. Never
retry a mutating command automatically after a timeout.

BLE device name: `S3-Sentinel-` plus the final six hex device-ID characters.

- Service: `7b6a0001-6c2d-4b7e-9f10-15a2b3c4d5e6`
- RX (write with response): `7b6a0002-6c2d-4b7e-9f10-15a2b3c4d5e6`
- TX (notify): `7b6a0003-6c2d-4b7e-9f10-15a2b3c4d5e6`

## Requests and replies

Request: `{"id":1,"op":"get","session":"0123456789abcdef"}`

Success: `{"id":1,"session":"0123456789abcdef","ok":true,"data":{...}}`

Failure: `{"id":1,"session":"0123456789abcdef","ok":false,"error":"invalid_config","message":"..."}`

Clients generate a new 16-hex-digit session nonce per connection/RpcClient and
match **both** id and session. Firmware echoes the request nonce, including for
asynchronous config/clear replies. This rejects late replies after a USB serial
close/reopen even when the USB Serial/JTAG driver cannot observe logical port
closure. Nonces correlate requests; they are not authentication secrets.
Manual serial commands may omit session, in which case replies omit it too.

Notifications: `{"event":"state","data":{...state}}` and
`{"event":"log","data":{...entry}}`. State notifications are coalesced and
limited to 5 Hz. They must not interrupt bytes of a command reply. Reply
transmission has priority over notifications. A slow receiver must not block
motion detection or buzzer deadlines.

| op | additional request fields | response data |
| --- | --- | --- |
| get | none | snapshot |
| set | `config`: partial config | snapshot, only after validated/persisted settings and radar acknowledgement |
| time | `epochMs`: UTC Unix milliseconds | snapshot |
| logs | `after`: last sequence, `limit`: 1..5 (default 5) | log page |
| test | none | snapshot; bounded manual buzzer test, does not increment triggerCount |
| stop | none | snapshot; stop output immediately and require motion release before rearming |
| clear | none | snapshot; clear log records but never reset the persistent sequence counter |

`test` is an explicit user action and bypasses armed/muted, but cannot extend
an already running beep. It returns `busy` when a beep is already active.
Disarming, muting, changing sensor/output settings and stop must promptly turn
off an existing output. Normal motion remains recorded while muted/disarmed.

Snapshot:

```
{deviceId,version,bootId,config,state,logs:{oldest,latest,count,capacity}}
```

The version starts with `1.`. `deviceId` is a stable chip identifier. Capacity
is 1000 records. `triggerCount` counts accepted motion episodes this boot,
never manual tests or individual radar data frames.

## Configuration

| field | default | accepted values |
| --- | --- | --- |
| sensor | "pir" | "pir", "radar" |
| armed | true | boolean |
| muted | false | boolean |
| beepMs | 3000 | integer 100..10000 |
| cooldownMs | 1000 | integer 0..10000 |
| confirmMs | 200 | integer 20..2000 |
| releaseMs | 500 | integer 50..5000 |
| warmupMs | 30000 | integer 0..120000; PIR startup settling interval |
| buzzerMode | "passive" | "passive", "active" |
| activeLow | false | boolean; invert active-module enable, not passive PWM |
| toneHz | 2000 | integer 200..5000; passive mode only |
| sound | "single" | "single", "double", "chime", "siren" |
| radarMaxGate | 4 | integer 2..8; 0.75 m gates (3 m default) |
| radarMotionThreshold | 35 | integer 0..100 |
| radarStillThreshold | 45 | integer 0..100 |

Reject unknown keys, wrong JSON types, fractions and out-of-range values;
configuration changes are atomic. PIR input uses GPIO13, with GPIO7 driving
the non-inverted passive buzzer by default. Radar uses UART1:
GPIO18 RX <- radar TX, GPIO17 TX -> radar RX, 256000 8N1. Module power is 5 V;
UART logic is 3.3 V. Configure gate resolution to 0.75 m or verify compatibility
before applying gates. Real module/firmware support is checked, not assumed.

PIR has no software-adjustable sensor sensitivity or distance. Clients disable
radar-only fields in PIR mode and explain the module's fixed hold time. Radar
configuration errors must be returned, not shown as success. Threshold values
are energy cutoffs: *lower* means more sensitive. These initial defaults need
onsite tuning; they are not calibrated performance guarantees.

### Sound patterns

The master beepMs deadline remains authoritative for every preset, including a
short final note. No note uses a blocking delay. `single` holds toneHz;
`double` repeats a cycle of 120ms on, 100ms off, 120ms on, 460ms off;
`chime` repeats 200ms at toneHz, 200ms at round(toneHz*0.8), 400ms off;
`siren` alternates round(toneHz*0.75) and round(toneHz*1.25) every 150ms.
Computed tones are clamped to 200..5000Hz. Active buzzer modules follow only
on/off cadence and cannot change pitch. State sounding reports the full alarm
window; optional outputOn reports the instantaneous waveform gate.

## Motion and timing

Use radar UART moving-target data, NOT the presence OUT signal, for a new
motion episode. Static presence is shown separately. Confirm activity for
confirmMs, accept one episode, and beep for the duration snapshotted at that
episode. Further activity is merged, never queues another beep or extends it.
After output ends, wait cooldownMs and a continuous releaseMs quiet period
before accepting a *new* confirmed rise. Held activity cannot retrigger on
expiry. All elapsed timers handle uint32 millis rollover. No unbounded loops,
blocking delay, filesystem writes, or radar configuration waits in BLE callbacks.
Radar data becomes stale after 2 s; never re-use stale motion as a new event.

State includes:

```
{motion,present,sounding,phase,uptimeMs,triggerCount,timeKnown,
 distanceCm,motionEnergy,stillEnergy,radarAgeMs,
 freeHeap,minFreeHeap,loopMaxUs,queueDrops,txDrops}
```

Phases: `warmup`, `ready`, `sounding`, `cooldown`, `waiting_release`,
`sensor_offline`. Clients tolerate added state fields.

## Log page and time

```
{entries:[{seq,bootId,uptimeMs,epochMs,type,result,distanceCm,energy}],
 oldest,latest,count,next,hasMore,reset}
```

Entries are returned in ascending sequence order, strictly greater than
`after`. `next` is the last returned sequence, or the supplied cursor on an
empty page. `reset` reports a cursor gap (clear/overwrite), so the client can
warn that older records are no longer available. A clear operation is explicit
and the UI confirms it. The sequence counter survives clear and reboot.
Log type is `motion` or `test`; result is `sounded`, `muted`, or `disarmed`.
Manual stop status is surfaced live; a logged `sounded` means sound was
initiated, not a guarantee of audible hardware or a full-length sound.

NVS stores settings. A bounded persistent log store holds event records, not
high-frequency telemetry. Record epochMs=0 until this boot has been time-synced;
display such entries as boot-relative time, never invent a wall-clock date.
Clients send `time` after connecting, namespace cache by deviceId, deduplicate
by seq, and reconnect/sync from the last confirmed cursor. A disconnected
mini-program does not receive live alarms; device operation remains local.
