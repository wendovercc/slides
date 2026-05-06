# Raspberry Pi Kiosk Setup

Each pavilion TV runs a Raspberry Pi booting directly into Chromium in kiosk mode, pointed at the relevant slideshow URL. No keyboard, mouse, or desktop environment is needed.

---

## Hardware

- Raspberry Pi 4 (2GB+ recommended) or Pi 3B+
- MicroSD card (16GB+, Class 10 or better)
- HDMI cable to TV
- USB-C power supply (Pi 4) or Micro-USB (Pi 3)
- Wired Ethernet recommended; WiFi works but is less reliable for always-on use

---

## Step 1: Flash the SD card

Download and install [Raspberry Pi Imager](https://www.raspberrypi.com/software/).

1. **Choose OS**: Raspberry Pi OS Lite (64-bit)
   - Under "Raspberry Pi OS (other)" → "Raspberry Pi OS Lite (64-bit)"
2. **Choose Storage**: your SD card
3. **Edit Settings** (the gear icon or Ctrl+Shift+X):

| Setting | Value |
|---------|-------|
| Hostname | `pavilion-1` (match the slideshow slug) |
| Username | `pi` |
| Password | something secure — note it down |
| WiFi | pavilion network SSID and password (if using WiFi) |
| Locale | Europe/London, keyboard layout GB |
| SSH | Enable — "Allow public-key authentication only" if you have a key |

4. Write the image, then insert the SD card into the Pi.

---

## Step 2: First boot and update

Power on the Pi. If using Ethernet it should be reachable immediately; WiFi may take 30–60 seconds.

```bash
ssh pi@pavilion-1.local
```

Run a full update before installing anything:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

---

## Step 3: Install kiosk components

Reconnect after reboot, then install the minimal X11 stack and Chromium:

```bash
sudo apt install --no-install-recommends -y \
  xserver-xorg \
  x11-xserver-utils \
  xinit \
  chromium-browser \
  unclutter
```

- `xserver-xorg` + `xinit` — minimal X display server, no desktop environment
- `x11-xserver-utils` — provides `xset` for disabling screen blanking
- `chromium-browser` — the kiosk browser
- `unclutter` — hides the mouse cursor after a short idle

---

## Step 4: Configure console auto-login

This makes the Pi log in as `pi` automatically on tty1 after boot (no keyboard needed).

```bash
sudo raspi-config
```

Navigate to: **1 System Options → S5 Boot / Auto Login → B2 Console Autologin**

---

## Step 5: Configure X and Chromium to start on login

Create `~/.bash_profile` so that logging in to tty1 starts X:

```bash
cat > ~/.bash_profile << 'EOF'
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  startx -- -nocursor
fi
EOF
```

Create `~/.xinitrc` to configure the display and launch Chromium:

```bash
cat > ~/.xinitrc << 'EOF'
#!/bin/bash

# Disable screen blanking and power management
xset s off
xset -dpms
xset s noblank

# Hide mouse cursor after 0.5s idle
unclutter -idle 0.5 -root &

# Launch Chromium in kiosk mode, restart automatically if it crashes
SLIDESHOW_URL="https://slides.wendovercc.org/slideshow/pavilion-1/"

while true; do
  chromium-browser \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --disable-translate \
    --disable-features=TranslateUI \
    --disable-session-crashed-bubble \
    --user-data-dir=/tmp/chromium-kiosk \
    "$SLIDESHOW_URL"
  sleep 5
done
EOF
chmod +x ~/.xinitrc
```

Key flags:
- `--kiosk` — full-screen, no address bar, no UI chrome
- `--noerrdialogs` — suppress crash dialogs
- `--user-data-dir=/tmp/chromium-kiosk` — fresh profile each boot, avoids "session restore" prompts
- The `while true` loop restarts Chromium automatically if it ever crashes

---

## Step 6: Test

```bash
sudo reboot
```

The Pi should boot, auto-login, start X, and open Chromium full-screen showing the slideshow. If you have a monitor attached you should see the slideshow within about 30 seconds of power-on.

To exit kiosk mode temporarily (e.g. for maintenance): SSH in and `sudo pkill chromium-browser`, then `sudo pkill xinit`.

---

## Step 7: (Optional) Rotate the display

If the TV is rotated or the image is upside-down, add a display rotation line to `~/.xinitrc` before the `unclutter` line:

```bash
# Rotate 180° (upside-down mount)
xrandr --output HDMI-1 --rotate inverted

# Rotate 90° clockwise (portrait, right-side up)
# xrandr --output HDMI-1 --rotate right
```

Run `xrandr` (without arguments) to find the correct output name if `HDMI-1` doesn't work.

---

## Step 8: (Optional) Prevent TV from sleeping

Some TVs go to standby after a period with no interaction. Two approaches:

**Option A**: Use a service like `xdotool` to simulate periodic mouse movement:

```bash
sudo apt install -y xdotool
```

Add to `~/.xinitrc` before the Chromium loop:

```bash
# Move mouse 1px every 4 minutes to keep TV awake
while true; do xdotool mousemove_relative 1 0; sleep 240; done &
```

**Option B**: Set the TV's own sleep/standby timer to "never" in its menu.

---

## Maintenance

### Updating Raspberry Pi OS

SSH in periodically:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

### Updating the slideshow content

No Pi access needed. The slideshow player re-fetches the config from `slides.wendovercc.org` at the `refresh_interval_seconds` interval (configured in `content/slideshows/pavilion-1.json`). Push a new build and the display picks it up automatically.

### Changing which slideshow a display shows

Edit the `SLIDESHOW_URL` in `~/.xinitrc` on the Pi, then `sudo reboot`.

### Adding a second display / pavilion

1. Create `content/slideshows/pavilion-2.json` in this repo
2. Run the build, push to `main`
3. Flash a second Pi using the same steps above, setting hostname `pavilion-2` and `SLIDESHOW_URL` to `https://slides.wendovercc.org/slideshow/pavilion-2/`

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Black screen after boot | SSH in; check `journalctl -b` for X errors |
| Chromium shows "profile in use" | Reboot — `/tmp/chromium-kiosk` clears on boot |
| "No display" error from `startx` | Check `~/.bash_profile` exists and `tty` is `/dev/tty1` |
| Slideshow not updating | Check network; try opening the URL in SSH: `curl -I https://slides.wendovercc.org/slideshow/pavilion-1/` |
| Screen goes blank after a while | Confirm `xset s off` and `xset -dpms` ran; check TV sleep settings |
