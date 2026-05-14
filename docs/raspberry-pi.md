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

Create `~/.bash_profile` so that logging in to tty1 starts cage with Chromium:

```bash
cat > ~/.bash_profile << 'EOF'
if [ -z "$WAYLAND_DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
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
      "https://slides.wendovercc.org/screen/the-witchell/"
    sleep 5
  done
fi
EOF
```

Replace `the-witchell` with the slug for the location this display shows. The hostname and the slideshow URL are independent — you can point any Pi at any location.

Key points:
- `cage` — runs Chromium fullscreen as a Wayland client
- `--kiosk` — full-screen, no address bar, no UI chrome
- `--user-data-dir=/tmp/chromium-kiosk` — fresh profile each boot, avoids "session restore" prompts
- The `while true` loop restarts Chromium automatically if it ever crashes
- The cursor is hidden via `cursor: none` CSS in the screen player itself

### Disable HDMI CEC

The TV presents itself as a pointer device via HDMI CEC, which can cause interference. Disable it:

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

Edit the URL at the end of the `cage` command in `~/.bash_profile` on the Pi, then `sudo reboot`.

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
| Slideshow not updating | Check network; try `curl -I https://slides.wendovercc.org/screen/the-witchell/` from SSH |
| Screen goes blank after a while | Check TV sleep/standby settings |
