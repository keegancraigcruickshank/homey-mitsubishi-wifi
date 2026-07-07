# Mitsubishi Wifi AC — Homey App

Control **Mitsubishi Electric air conditioners / heat pumps** from
[Homey](https://homey.app), entirely over your local network using the
[ECHONET Lite](https://echonet.jp/english/) protocol — no cloud, no MELCloud
account required.

![Mitsubishi Wifi AC](assets/images/xlarge.jpg)

The app talks directly to the Wi-Fi interface adapter fitted to the indoor unit
(**MAC-558IF-E / MAC-567IF-E / MAC-568IF-E / MAC-578IF-E / MAC-588IF-E**), using
the standard ECHONET *Home air conditioner* device class (class group `0x01`,
class `0x30`).

## Features

- **Power** on / off
- **Mode** — Automatic, Cooling, Heating, Dehumidify, Fan only
- **Target temperature** — 16–31 °C
- **Room & outdoor temperature** readings
- **Fan speed** — Auto, Quiet, Low, Medium, High, Maximum
- **Vertical vane** — Auto, Top, Upper, Middle, Lower, Bottom, Swing
- Every capability is available in **Flows** as triggers, conditions and actions
- **100 % local**: state is polled straight from the unit (default every 60 s),
  so changes made with the IR remote or MELCloud show up in Homey

## Requirements

1. A supported Mitsubishi Wi-Fi adapter (see models above) connected to your LAN.
2. **ECHONET Lite enabled on the adapter.** In the *MELCloud* / *Mitsubishi
   Wi-Fi* app, open the device settings and turn on the ECHONET Lite option
   ([instructions](https://www.mitsubishi-electric.co.nz/wifi/learn_echonet.aspx)).
3. Homey and the air conditioner on the same subnet, with UDP port **3610**
   reachable. Automatic discovery uses ECHONET multicast (`224.0.23.0`).

> [!TIP]
> Give the adapter a **static DHCP reservation** in your router so its IP
> address never changes.

## Installation

### From the Homey App Store

*Coming soon.*

### From source

```bash
npm install -g homey   # Homey CLI
homey login
git clone https://github.com/keegancraigcruickshank/homey-mitsubishi-wifi.git
cd homey-mitsubishi-wifi
homey app install
```

## Pairing

In the Homey app choose **Add device → Mitsubishi Wifi AC → Mitsubishi Air
Conditioner**. The app multicasts an ECHONET discovery request and lists every
air conditioner it finds.

If your network blocks multicast (common with managed switches, VLANs, or a
Homey running in Docker), use the **manual IP entry** option in the pairing
flow instead. The IP address and poll interval can also be changed later in the
device's settings.

## Development

`app.json` is generated from the Homey Compose sources — treat
`.homeycompose/` and `drivers/` as the source of truth.

```
.homeycompose/            App manifest + custom capability definitions
  app.json                App metadata (id, version, images, …)
  capabilities/           ac_mode, fan_speed, vane_vertical (enum pickers)
app.js                    Homey.App entry point
lib/
  EchonetLite.js          ECHONET Lite Format-1 frame build/parse, get/set, discovery (UDP)
  constants.js            EPC codes + Mitsubishi value <-> friendly mappings
drivers/mitsubishi-ac/
  driver.compose.json     Driver manifest (class, capabilities, pairing, settings)
  driver.js               Discovery during pairing
  device.js               Polling + capability listeners
```

After editing anything under `.homeycompose/` or `drivers/`:

```bash
homey app build
homey app validate --level publish
homey app run              # live development against your Homey
```

## Protocol notes

- Frames are ECHONET Lite **Format 1**: `EHD1=0x10`, `EHD2=0x81`, 16-bit TID,
  3-byte SEOJ (`05 FF 01`, controller), 3-byte DEOJ (`01 30 01`, home AC), ESV,
  OPC, then `EPC/PDC/EDT` triplets.
- Reads use **Get** (`0x62`); writes use **SetC** (`0x61`) and await `Set_Res`
  (`0x71`). Requests are correlated by TID and retried on timeout.
- Discovery queries the node-profile object (`0E F0 01`) for the self-node
  instance list (`0xD6`) and keeps only nodes that advertise a
  home-air-conditioner instance (`01 30 ..`).

| Capability | ECHONET property |
|---|---|
| On / off | `0x80` |
| Mode | `0xB0` |
| Target temperature | `0xB3` (whole degrees; half-degree requests are rounded) |
| Room temperature | `0xBB` (read-only, signed) |
| Outdoor temperature | `0xBE` (read-only) |
| Fan speed | `0xA0` |
| Vertical vane | `0xA1 / 0xA3 / 0xA4` |

EPC/value mappings follow the ECHONET Lite *Home air conditioner* class and the
Mitsubishi behaviour catalogued in
[`scottyphillips/mitsubishi_echonet`](https://github.com/scottyphillips/mitsubishi_echonet).

## Known limitations

- Target temperature is whole-degree (ECHONET `0xB3` granularity).
- Horizontal vane (`0xA5`) and error/special-state reporting (`0xAA`) are not
  yet surfaced.

## Support

- Bugs and feature requests: [GitHub issues](https://github.com/keegancraigcruickshank/homey-mitsubishi-wifi/issues)
- Contact: [keegan@cloudpixel.com.au](mailto:keegan@cloudpixel.com.au)

## License

[MIT](LICENSE.md) © Cloud Pixel
