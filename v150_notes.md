🚀 What's New in v1.5.0

🔌 Direct USB HID Connection (No more ViewPower!)
- **Major Architecture Change:** The app now communicates directly with your UPS over USB using native HID protocols.
- **Goodbye ViewPower:** You no longer need to run the ViewPower software in the background. You can uninstall it completely!
- **Lower Resource Usage:** Direct USB polling is significantly faster and uses less memory and CPU than scraping ViewPower's web interface.

🧹 Cleanup and Fixes
- Removed the broken "Household Bill Predictor" feature to streamline the experience and focus on core UPS monitoring.
- Updated all UI text and tray icon statuses to remove legacy references to ViewPower.
- Packaged the hidapi C-extension directly into the executable for seamless standalone installation.
