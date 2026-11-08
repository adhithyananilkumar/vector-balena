# Flashing devices for Vector

How a device gets from a blank SD card / disk to "Online" in your Vector fleet, how headless and
device-specific flashing work, and what you must change for real hardware.

> **Status of the facts below.** Commands marked ✅ are used verbatim by this repo's own end-to-end test
> (`src/balena-tests/balena.sh`) or are quoted from the official balena CLI reference. Commands marked ⚠️
> came from a summary of the docs: check the exact flags with `balena <command> --help` before relying on them.

## 1. The moving parts

| Piece | What it is |
|---|---|
| **balenaOS image** | The device operating system (`.img`). It is *unconfigured* when downloaded: on its own it will not connect to any server. |
| **`config.json`** | A small file on the image's boot partition that tells the device *which server to use* and *who it is*. Flashing is "write the image" plus "put the right `config.json` on it". |
| **Flasher** | Whatever writes the image to the card/disk: **balenaEtcher** (GUI, open source) or `balena local flash` (CLI). |
| **Your Vector server** | Stores fleets, releases and devices. It does **not** host OS images; those come from balena's public download service (the repo's test downloads `generic-amd64` from `https://api.balena-cloud.com/download?deviceType=…&version=…&fileType=.zip`). |

The `config.json` that matters for a self-hosted server contains these keys (they are what the virtual device
in the test carries):

```json
{
  "apiEndpoint": "https://api.<your-domain>",
  "vpnEndpoint": "cloudlink.<your-domain>",
  "registryEndpoint": "registry2.<your-domain>",
  "deltaEndpoint": "https://delta.<your-domain>",
  "uuid": "<device uuid>",
  "balenaRootCA": "<base64 of your private CA>"
}
```

`balenaRootCA` is what lets the device trust your self-signed certificate. Without it every HTTPS call fails.

## 2. Two ways to provision

### A. Device-specific (pre-registered) ✅ recommended for you

You create the device record first, so it has a known identity before it ever powers on.

```bash
balena device register <fleet> --uuid <uuid>                       # ✅ the test does exactly this
balena config generate --device <uuid> --version <os-version> \
    --network ethernet --appUpdatePollInterval 10 --output config.json   # ✅
balena os configure <image.img> --config config.json                # ✅
```

* Re-flashing a card keeps the **same device** (same UUID, same history).
* Nothing on the image can enrol other devices.
* Best for known hardware, replacements and offline factory flashing.

### B. Fleet-wide ("provisioning key") image

You configure one image for the whole fleet and every device flashed from it registers itself on first boot.

```bash
balena config generate --fleet <fleet> --version <os-version> --network ethernet   # ✅ verbatim from the CLI reference
balena os configure <image.img> --config config.json
```

The CLI reference documents `--provisioning-key-name` and `--provisioning-key-expiry-date` for this mode. Official
warning: *anyone with access to the image can add a device to your fleet*, so keep these images private and
give the provisioning key an expiry.

### One-command shortcut ⚠️

`balena device init` registers a device, downloads the OS, configures it and writes it to a drive in one go.

## 3. Headless (no screen, no keyboard)

* **Ethernet:** nothing to do. `--network ethernet` (DHCP) works headless.
* **Wi-Fi:** bake it in when generating the config ✅ (verbatim from the CLI reference):

  ```bash
  balena config generate --fleet <fleet> --version <v> --network wifi --wifiSsid "<ssid>" --wifiKey "<password>"
  ```
* **Any other network setup:** drop NetworkManager connection files into a `system-connections` folder on the boot
  partition; the OS copies them to `/etc/NetworkManager/system-connections` (official OS overview).
* **Development mode:** add `--dev` ✅ while testing. It gives passwordless root console and SSH on port 22222.
  Never ship a development image to production.
* Poll interval: `--appUpdatePollInterval 10` makes a test device check for updates every 10 s.

## 4. Writing the image to the card

1. **balenaEtcher (GUI, Windows/Mac/Linux):** *Flash from file* → pick the configured `.img` (or `.zip`) → pick the
   card → *Flash*. It verifies the write afterwards. Run it as administrator on Windows.
2. **CLI ⚠️:** `balena local flash <image.img> --drive <device> --yes` (on Windows list drives with
   `balena util available-drives`).
3. **Internal storage (eMMC / NVMe / x86 PCs):** these boards need a *flasher* (installer) image: you boot from a
   USB stick, it writes balenaOS to the internal disk, then you remove the stick. (General balena behaviour; the
   exact CLI option for it, `balena os download --type installation-media` ⚠️, was not confirmed.) The
   `installer.*` keys in `config.json` control it (`installer.target_devices`, `installer.secureboot`).

## 5. What has to change for real hardware (important)

The test device works because QEMU hands it a private network where `protofleet.local` is resolvable.
Real devices on your LAN are different:

1. **`.local` will not work.** `.local` is reserved for multicast DNS, and your `hosts`-file entries only exist on
   this PC. Use a real domain you control (for example `fleet.example.com`) with DNS records for
   `api, registry2, cloudlink, logs, s3, tunnel, delta` pointing at the server's address, or run a small LAN DNS
   (router / Pi-hole / dnsmasq) that answers those names.
   **Lesson from the virtual-device test:** balenaOS adds `8.8.8.8` as a fallback resolver. Public DNS answers
   "no such name" for a private domain, and the device's dnsmasq takes the first answer, so the device
   intermittently cannot find the API even when your own DNS is correct. Set `"dnsServers"` in `config.json`
   to your own resolver (the test uses `"dnsServers": "10.0.2.3"`), or use a public domain that `8.8.8.8` can
   also resolve.
2. **Reachability.** Port **443** must be open from the devices to the server (the VPN also listens on 443).
3. **Certificate trust.** Keep the CA in `config.json` (`balenaRootCA`), or use a publicly trusted certificate
   (Let's Encrypt via the `auto-pki` target) and drop the CA entirely.
4. **Clock.** Devices without a battery clock (Raspberry Pi) need a network time source or TLS fails; `ntpServers`
   is a documented `config.json` key.

## 6. Reusing a flashed drive by swapping `config.json`

The image is identical for every device; only `config.json` (server + identity) differs. The boot partition is a
plain FAT drive (label `resin-boot`), so you can replace `config.json` on a flashed USB stick or SD card without
reflashing: paste it in on Windows, or use the CLI (`balena config read | write | inject … --drive <drive>`,
documented to work on an image file or an attached SD card / USB stick; check `--help` for exact usage).

| Situation | Can you reuse it? |
|---|---|
| Flashed, **never booted** | Yes. Swap `config.json` as often as you like. |
| **Installer / flasher** stick for devices with internal storage, fleet-wide config | Yes, as is. Every device it installs registers itself. |
| Installer stick, **device-specific** config | Yes, but swap in a **new** `config.json` (new UUID + key) before each device. |
| SD card / USB that a device **booted from** | Replace `config.json` **and reflash**. The card now holds that device's identity and state (supervisor database, data partition). Swapping only the config may leave stale state. |
| One config on **two devices** | No. Two devices with the same UUID collide. Only fleet-wide (provisioning key) configs may be shared. |
| Switching **development ↔ production** | No. They are separate images; `config.json` / `--dev` cannot convert one into the other. |

Notes from the sources: a device UUID must be 32 hex characters; regenerating config for an already-registered
device can reset its device type to the fleet default; and a running device keeps its file at
`/mnt/boot/config.json`. Behaviour after first boot (what the OS rewrites in `config.json`) and installer-stick
details were **not confirmed** in the docs pages I could read: test with one spare card before a production run.

## 7. Suggested Vector "Add device" flow

Everything above can be a wizard in the Vector UI, so nobody types CLI commands:

1. Pick a fleet, a device type, an OS version, *dev/production*, and the network (Ethernet or Wi-Fi + password).
2. The UI server registers the device, generates `config.json` with your endpoints and CA, and returns a
   **configured image** (or just the `config.json` to inject).
3. The UI shows a one-line **Flash with balenaEtcher** instruction and a **device status** view that turns green
   when the device comes online (the same check the end-to-end test uses).

See `docs/` and the Vector UI backlog for the next step.
