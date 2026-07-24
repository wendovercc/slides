# Raspberry Pi Kiosk Setup

Each pavilion TV runs a Raspberry Pi 5 booting directly into Chromium in kiosk mode via the Wayland compositor `cage`, pointed at the relevant screen URL. No keyboard, mouse, or desktop environment is needed.

---

## Hardware

- Raspberry Pi 5 (4GB recommended)
- MicroSD card (16GB+, Class 10 or better)
- HDMI cable to TV
- USB-C power supply (27W recommended for Pi 5)
- Wired Ethernet recommended; WiFi works but is less reliable for always-on use

---

## SSH key setup

Create a dedicated key pair on your Mac before flashing:

```bash
ssh-keygen -t ed25519 -C "wendovercc-pi" -f ~/.ssh/wendovercc_pi
```

The private key (`~/.ssh/wendovercc_pi`) stays on your Mac — back it up to a password manager. The public key (`~/.ssh/wendovercc_pi.pub`) goes onto the Pi via the Imager.

---

## Step 1: Flash the SD card

Download and install [Raspberry Pi Imager](https://www.raspberrypi.com/software/).

1. **Choose OS**: Raspberry Pi OS Lite (64-bit)
   - Under "Raspberry Pi OS (other)" → "Raspberry Pi OS Lite (64-bit)"
2. **Choose Storage**: your SD card
3. **Edit Settings** (the gear icon or Ctrl+Shift+X):

| Setting | Value |
|---------|-------|
| Hostname | `wendovercc-1` (or `wendovercc-2` etc. — independent of which slideshow it shows) |
| Username | `pi` |
| Password | Alphanumeric only, no special characters — the Imager can mangle them |
| WiFi | Pavilion network SSID and password (if using WiFi); choose Secure |
| Locale | Europe/London (handles BST automatically), keyboard layout GB |
| SSH | Enable — "Allow public-key authentication only" |
| Public key | Paste the contents of `~/.ssh/wendovercc_pi.pub` (`cat ~/.ssh/wendovercc_pi.pub`) |

4. Write the image, then insert the SD card into the Pi.

---

## Step 2: First boot and update

Power on the Pi. If using Ethernet it should be reachable immediately; WiFi may take 30–60 seconds.

Always specify the key explicitly:

```bash
ssh -i ~/.ssh/wendovercc_pi pi@wendovercc-1.local
```

On first connection SSH will ask you to confirm the host fingerprint — type `yes`. If you have re-flashed the SD card and get a host key warning, clear the old entry first:

```bash
ssh-keygen -R wendovercc-1.local
```

> **Before pasting any multi-line block in these steps, run `sudo -v` first.** It authenticates sudo up front (cached ~15 min), so a `sudo` command inside a pasted block won't stop to ask for a password mid-paste — which desyncs the paste and can leave the heredoc/`tee` blocks failing silently with no output.

Run a full update before installing anything:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

If you see `501 Not Implemented` errors during the update, run `sudo apt update` again — it retries with a different mirror.

---

## Step 3: Install kiosk components

Reconnect after reboot, then install `cage` (Wayland compositor) and Chromium:

```bash
sudo apt install --no-install-recommends -y \
  cage \
  chromium
```

- `cage` — minimal Wayland compositor that runs a single application fullscreen (Pi 5 native display stack)
- `chromium` — the kiosk browser

---

## Step 4: Configure console auto-login

This makes the Pi log in as `pi` automatically on tty1 after boot (no keyboard needed).

`raspi-config` navigation is unreliable over SSH, so configure it directly:

```bash
sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf << 'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin pi --noclear %I $TERM
EOF
```

---

## Step 5: Configure cage and Chromium to start on login

Create `~/.kiosk_url` with the URL for this display:

```bash
echo "https://slides.wendovercc.org/screen/the-witchell/" > ~/.kiosk_url
```

Replace `the-witchell` with the slug for this location. The hostname and the slideshow URL are independent — you can point any Pi at any location.

Create `~/.bash_profile` so that logging in to tty1 starts cage with Chromium:

```bash
cat > ~/.bash_profile << 'EOF'
if [ -z "$WAYLAND_DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  SLIDESHOW_URL=$(cat ~/.kiosk_url)
  while true; do
    cage -- chromium \
      --kiosk \
      --noerrdialogs \
      --disable-infobars \
      --no-first-run \
      --disable-translate \
      --disable-features=TranslateUI \
      --disable-session-crashed-bubble \
      --user-data-dir=/tmp/chromium-kiosk \
      --disk-cache-size=524288000 \
      "$SLIDESHOW_URL"
    sleep 5
  done
fi
EOF
```

Key points:
- `cage` — runs Chromium fullscreen as a Wayland client
- `--kiosk` — full-screen, no address bar, no UI chrome
- `--user-data-dir=/tmp/chromium-kiosk` — fresh profile each boot, avoids "session restore" prompts
- `--disk-cache-size=524288000` — 500 MB cache (default is 80 MB, too small for large video files)
- The `while true` loop restarts Chromium automatically if it ever crashes
- The cursor is hidden via `cursor: none` CSS in the screen player itself

> **Note — the profile lives on RAM (`/tmp`), and that's deliberate for a card-booted Pi.**
> `/tmp` is `tmpfs` (RAM), so the whole Chromium profile — including the app's video
> store (the `wcc-video-v1` Cache API entry that `assets/js/video-cache.js` fills) — is
> **wiped on every nightly reboot**. Expected consequence: **one cold download of each
> clip per morning** (~80 MB for the current reel), then nothing more for the rest of the
> day. The expensive per-loop refetch is fixed separately in app code (fetch-to-Cache-API
> + object-URL playback), so it does **not** depend on where the profile lives.
>
> Moving `--user-data-dir` to the SD card (e.g. `/home/pi/.chromium-kiosk`) would save
> that one download/day, but for a **microSD-booted** Pi running for years the RAM profile
> is the better default:
> - **No flash wear.** A live profile writes constantly (cache, LevelDB, cookies, logs);
>   on tmpfs those writes cost nothing, on microSD they slowly grind the card down — the
>   classic long-term Pi kiosk failure. The clean-boot profile also **self-heals** any
>   corruption, so "turn it off and on again" stays a real fix; a persisted profile keeps
>   its corruption across reboots.
> - **RAM headroom is fine** — a handful of 80 MB clips sits comfortably under the ~2 GB
>   tmpfs ceiling on a 4 GB Pi 5.
>
> **Flip this only if the Pi boots from an SSD/NVMe** rather than microSD — SSD endurance
> removes the wear objection, so a persistent profile (and zero re-downloads) becomes the
> better choice there. (This supersedes the "move `--user-data-dir` to SD" step described
> as a prerequisite in `docs/player-offline-architecture.md` Phase 0, which predates this
> decision.)

### Install the kiosk control server

A small Python HTTP server runs on port 8080 and lets you restart the kiosk from any device on the same network — no SSH needed. The slideshow homepage shows a "↺ Restart screen" link on screen cards that have a Pi configured; clicking it opens `http://wendovercc-1.local:8080/` in a new tab where you can trigger the restart.

Copy the script from the repo:

```bash
sudo cp /path/to/repo/scripts/kiosk-control.py /usr/local/bin/kiosk-control.py
sudo cp /path/to/repo/scripts/kiosk-control.service /etc/systemd/system/kiosk-control.service
```

Or paste them directly — the source files are `scripts/kiosk-control.py` and `scripts/kiosk-control.service` in this repo.

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kiosk-control.service
```

Confirm it's running:

```bash
systemctl status kiosk-control.service
```

To test: open `http://wendovercc-1.local:8080/` in a browser on the same network and click **Restart kiosk**. The screen will go dark briefly, then Chromium restarts from the `while true` loop.

> The control server is only reachable on the local network (mDNS `.local` hostname). It requires no authentication — anyone on the same WiFi can restart the kiosk, which is acceptable for a pavilion LAN.

### Hide the system cursor

On Pi 5, the HDMI ports register as input devices with pointer capabilities, causing wlroots to render a system-level cursor at centre screen regardless of CSS. Fix with a udev rule that tells libinput to ignore those devices — with no pointer device registered, no cursor is rendered:

```bash
sudo tee /etc/udev/rules.d/99-ignore-hdmi-input.rules << 'EOF'
ACTION=="add", SUBSYSTEM=="input", ATTRS{name}=="vc4-hdmi-0", ENV{LIBINPUT_IGNORE_DEVICE}="1"
ACTION=="add", SUBSYSTEM=="input", ATTRS{name}=="vc4-hdmi-1", ENV{LIBINPUT_IGNORE_DEVICE}="1"
EOF
sudo udevadm control --reload-rules
```

### Disable HDMI CEC

Optionally also disable CEC to prevent the TV remote from sending input events to the Pi:

```bash
echo "hdmi_ignore_cec=1" | sudo tee -a /boot/firmware/config.txt
```

---

## Step 6: Test

```bash
sudo reboot
```

The Pi should boot, auto-login, start cage, and open Chromium full-screen showing the slideshow within about 30 seconds of power-on.

To exit kiosk mode temporarily (e.g. for maintenance): SSH in and run:

```bash
sudo pkill chromium
sudo pkill cage
```

---

## Step 7: (Optional) Rotate the display

If the TV is rotated or the image is upside-down, add a `display_rotate` entry to `/boot/firmware/config.txt`:

```bash
# Rotate 180° (upside-down mount)
echo "display_rotate=2" | sudo tee -a /boot/firmware/config.txt

# Rotate 90° clockwise
# echo "display_rotate=1" | sudo tee -a /boot/firmware/config.txt
```

Then `sudo reboot`.

---

## Step 8: (Optional) Prevent TV from sleeping

Set the TV's own sleep/standby timer to "never" in its menu — this is the most reliable approach.

---

## Step 9: Scheduled nightly power-off and wake

To save power and TV lifespan, the Pi powers itself off at midnight and wakes itself at 09:00.

### How it works on Pi 5

Unlike earlier models, the Pi 5 has a built-in real-time clock (RTC) and a power-management IC (PMIC) that supports a genuine low-power "off" state it can wake itself out of:

- At **midnight**, a systemd timer runs a script that arms the RTC wake alarm for the next 09:00, then powers the board off into the PMIC's low-power state (a few milliwatts).
- At **09:00**, the RTC alarm fires, the PMIC powers the board back up, and it boots straight back into the kiosk (auto-login → cage → Chromium).

Important: this requires the Pi to **stay connected to its PSU**. "Off" here means the low-power standby state, not unplugged — the RTC keeps time off the 5V standby rail. (The optional RTC backup battery is only needed to survive a full power cut, which isn't our case, since the PSU stays plugged in even though the socket is out of reach.) The Pi syncs its clock from the network on boot, so the alarm time stays accurate.

### Step 9a: Enable low-power halt in the bootloader

Set `POWER_OFF_ON_HALT=1` in the bootloader EEPROM config so that power-off enters the deepest wake-capable state:

```bash
rpi-eeprom-config > /tmp/boot.conf
grep -q '^POWER_OFF_ON_HALT' /tmp/boot.conf || echo 'POWER_OFF_ON_HALT=1' >> /tmp/boot.conf
sudo rpi-eeprom-config --apply /tmp/boot.conf
sudo reboot
```

After rebooting, confirm it stuck:

```bash
rpi-eeprom-config | grep POWER_OFF_ON_HALT
```

The onboard power button still wakes the Pi manually from this state with a short press — useful if you ever need it on outside the 09:00–00:00 window without reaching the socket.

### Step 9b: Create the sleep script

This computes the next 09:00, arms the RTC alarm, and powers off. It runs as root via systemd, so no `sudo` inside.

```bash
sudo tee /usr/local/bin/kiosk-sleep << 'EOF'
#!/bin/bash
# Arm the RTC to wake the Pi, then power off into the low-power state.
set -e
WAKE_HOUR=09:00

WAKE=$(date -d "today $WAKE_HOUR" +%s)
NOW=$(date +%s)
if [ "$WAKE" -le "$NOW" ]; then
  WAKE=$(date -d "tomorrow $WAKE_HOUR" +%s)
fi

# sysfs requires clearing any pending alarm (write 0) before setting a new one.
echo 0 > /sys/class/rtc/rtc0/wakealarm
echo "$WAKE" > /sys/class/rtc/rtc0/wakealarm

logger -t kiosk-sleep "Wake alarm set for $(date -d @"$WAKE"); powering off"
systemctl poweroff
EOF
sudo chmod +x /usr/local/bin/kiosk-sleep
```

To change the wake time later, edit `WAKE_HOUR` (24-hour, local time — BST is handled automatically).

### Step 9c: Create the midnight timer

A systemd service to run the script, and a timer to fire it at 00:00:

```bash
sudo tee /etc/systemd/system/kiosk-sleep.service << 'EOF'
[Unit]
Description=Arm RTC wake alarm and power off the kiosk for the night

[Service]
Type=oneshot
ExecStart=/usr/local/bin/kiosk-sleep
EOF

sudo tee /etc/systemd/system/kiosk-sleep.timer << 'EOF'
[Unit]
Description=Power off the kiosk at midnight

[Timer]
OnCalendar=*-*-* 00:00:00
Persistent=false

[Install]
WantedBy=timers.target
EOF
```

`Persistent=false` is deliberate: if the Pi happened to be off across a midnight, we do *not* want it to immediately shut down again the moment it boots — it should only power off when it's actually running at midnight.

Enable the timer (this enables and starts the *timer*, not the service):

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kiosk-sleep.timer
```

Confirm it's scheduled:

```bash
systemctl list-timers kiosk-sleep.timer
```

You should see the next trigger at the upcoming midnight.

### Step 9d: Test without waiting

Arm the alarm for two minutes out and power off manually — the Pi should switch off and come back ~2 minutes later:

```bash
echo 0 | sudo tee /sys/class/rtc/rtc0/wakealarm
echo $(( $(date +%s) + 120 )) | sudo tee /sys/class/rtc/rtc0/wakealarm
sudo systemctl poweroff
```

If it comes back on by itself, the full cycle works. (Run this when you can watch it — once it's off you can't SSH in until it wakes.)

---

## Common tasks over SSH

### Connect to the Pi

```bash
ssh -i ~/.ssh/wendovercc_pi pi@wendovercc-1.local
```

If you get a host key warning after re-flashing:
```bash
ssh-keygen -R wendovercc-1.local
```

### Change the slideshow URL

```bash
echo "https://slides.wendovercc.org/screen/new-slug/" > ~/.kiosk_url
sudo reboot
```

### Add a WiFi network

NetworkManager keeps a list of saved networks and connects to whichever is in range on boot. To add a new one:

```bash
# See what networks are nearby
nmcli device wifi list

# Add and connect to a new network (existing saved networks are kept)
nmcli device wifi connect "NetworkName" password "password"
```

To see all saved networks: `nmcli connection show`

### Restart the kiosk without rebooting

**From any device on the same network:** open `http://wendovercc-1.local:8080/` and click **Restart kiosk**.

**Over SSH:**

```bash
pkill chromium
pkill cage
```

The `~/.bash_profile` loop will restart cage and Chromium automatically within a few seconds.

### Reboot the Pi

```bash
sudo reboot
```

### Check if the kiosk is running

```bash
pgrep -a chromium
```

If nothing is returned, the kiosk isn't running. Check `journalctl -b` for errors.

### Change the nightly sleep/wake times

- **Wake time**: edit `WAKE_HOUR` in `/usr/local/bin/kiosk-sleep`.
- **Sleep time**: edit `OnCalendar=` in `/etc/systemd/system/kiosk-sleep.timer`, then `sudo systemctl daemon-reload`.

Confirm the next run with `systemctl list-timers kiosk-sleep.timer`.

### Skip tonight's shutdown / keep it on temporarily

```bash
sudo systemctl stop kiosk-sleep.timer    # won't power off tonight
sudo systemctl start kiosk-sleep.timer   # re-arm (or just reboot)
```

To disable scheduled power entirely: `sudo systemctl disable --now kiosk-sleep.timer`.

---

## Maintenance

### Updating Raspberry Pi OS

SSH in periodically:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

### Updating the slideshow content

No Pi access needed. The screen player re-fetches content automatically. Push a new build and the display picks it up within the configured refresh interval.

### Changing which slideshow a display shows

```bash
echo "https://slides.wendovercc.org/screen/new-slug/" > ~/.kiosk_url
sudo reboot
```

### Adding a second display / pavilion

1. Create the relevant location content file in this repo
2. Run the build, push to `main`
3. Flash a second Pi using the same steps above, setting hostname `wendovercc-2` and updating the URL in `~/.bash_profile` to the new location slug

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Black screen after boot | SSH in; check `journalctl -b` for cage errors |
| Chromium shows "profile in use" | Reboot — `/tmp/chromium-kiosk` clears on boot |
| Can't log in via SSH | Use `ssh -i ~/.ssh/wendovercc_pi pi@wendovercc-1.local`; if re-flashed, run `ssh-keygen -R wendovercc-1.local` first |
| sudo password not accepted | Avoid special characters in the Imager password — re-flash with an alphanumeric password |
| Cursor visible at centre screen | Add the udev rule in Step 5 to hide HDMI input devices from libinput |
| High mobile data usage | Likely the video is larger than Chromium's default 80 MB cache — ensure `--disk-cache-size=524288000` is in `~/.bash_profile` (Step 5) |
| Need to restart remotely | Open `http://wendovercc-1.local:8080/` on any device on the same network; or SSH and run `pkill chromium; pkill cage` |
| Slideshow not updating | Check network; try `curl -I https://slides.wendovercc.org/screen/the-witchell/` from SSH |
| Screen goes blank after a while | Check TV sleep/standby settings |
| Pi doesn't wake at 09:00 | Confirm PSU stayed powered (wake needs 5V standby); `rpi-eeprom-config \| grep POWER_OFF_ON_HALT` should be `1`; update the bootloader with `sudo apt full-upgrade` then reboot |
| Pi doesn't power off at midnight | `systemctl list-timers kiosk-sleep.timer` to check it's scheduled; `journalctl -u kiosk-sleep.service` for errors |
| Wakes at the wrong time | Clock skew — check `timedatectl`; the alarm is set from system time, which syncs from the network on boot |
