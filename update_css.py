import re

with open('static/style.css', 'r', encoding='utf-8') as f:
    css = f.read()

# 1. Update .card
css = css.replace('.card {\n  background: var(--card-bg);\n  border: 1px solid var(--card-border);\n  border-radius: var(--radius);\n  backdrop-filter: blur(16px);\n  padding: 24px;\n  transition: transform 0.4s cubic-bezier(0.165, 0.84, 0.44, 1), box-shadow 0.4s cubic-bezier(0.165, 0.84, 0.44, 1), border-color 0.4s cubic-bezier(0.165, 0.84, 0.44, 1);\n}', '.card {\n  background: rgba(10, 14, 26, 0.4);\n  border: 1px solid rgba(255, 255, 255, 0.08);\n  border-radius: var(--radius);\n  backdrop-filter: blur(24px);\n  -webkit-backdrop-filter: blur(24px);\n  padding: 24px;\n  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2), inset 0 1px 1px rgba(255, 255, 255, 0.05);\n  transition: transform 0.4s cubic-bezier(0.165, 0.84, 0.44, 1), box-shadow 0.4s cubic-bezier(0.165, 0.84, 0.44, 1), border-color 0.4s cubic-bezier(0.165, 0.84, 0.44, 1);\n}')

# 2. Update .card:hover
css = css.replace('.card:hover {\n  transform: translateY(-4px);\n  box-shadow: 0 16px 48px rgba(0,229,160,0.12);\n  border-color: rgba(0,229,160,0.3);\n}', '.card:hover {\n  transform: translateY(-4px);\n  box-shadow: 0 16px 48px rgba(0,229,160,0.15), inset 0 1px 1px rgba(255, 255, 255, 0.1);\n  border-color: rgba(0,229,160,0.4);\n}')

# 3. Update .gauge-watts
css = css.replace('.gauge-watts {\n  font-size: 2.6rem;\n  font-weight: 800;\n  color: var(--accent);\n  font-family: var(--mono);\n  line-height: 1;\n  text-shadow: 0 0 20px rgba(0,229,160,0.5);\n  transition: color var(--transition);\n}', '.gauge-watts {\n  font-size: 2.8rem;\n  font-weight: 800;\n  background: linear-gradient(135deg, var(--accent), var(--accent2));\n  -webkit-background-clip: text;\n  -webkit-text-fill-color: transparent;\n  font-family: var(--mono);\n  line-height: 1.1;\n  filter: drop-shadow(0 0 12px rgba(0,229,160,0.4));\n  transition: opacity var(--transition);\n}')

# 4. Update .today-val
css = css.replace('.today-val  { font-size: 1.4rem; font-weight: 700; color: var(--text); font-family: var(--mono); }', '.today-val { \n  font-size: 1.6rem; \n  font-weight: 800; \n  background: linear-gradient(135deg, #ffffff, #a5b4fc);\n  -webkit-background-clip: text;\n  -webkit-text-fill-color: transparent;\n  font-family: var(--mono); \n  filter: drop-shadow(0 0 8px rgba(255,255,255,0.1));\n}')

# 5. Update .m-stat-val
css = css.replace('.m-stat-val { font-size: 1.4rem; font-weight: 700; color: var(--text); font-family: var(--mono); }', '.m-stat-val { \n  font-size: 1.6rem; \n  font-weight: 800; \n  background: linear-gradient(135deg, #ffffff, #a5b4fc);\n  -webkit-background-clip: text;\n  -webkit-text-fill-color: transparent;\n  font-family: var(--mono); \n}')

# 6. Update .vital-item:hover
css = css.replace('.vital-item:hover {\n  border-color: rgba(0,229,160,0.35);\n  transform: translateY(-2px) scale(1.02);\n  background: rgba(255,255,255,0.05);\n  box-shadow: 0 8px 24px rgba(0,0,0,0.12);\n}', '.vital-item:hover {\n  border-color: rgba(0,229,160,0.4);\n  transform: translateY(-2px) scale(1.02);\n  background: rgba(255,255,255,0.06);\n  box-shadow: 0 8px 24px rgba(0,229,160,0.15), inset 0 1px 1px rgba(255,255,255,0.1);\n}')

# 7. Update .bill-card-val
css = css.replace('.bill-card-val   { font-size: 1.35rem; font-weight: 700; color: var(--text); letter-spacing: -0.02em; }', '.bill-card-val   { font-size: 1.4rem; font-weight: 800; color: var(--text); letter-spacing: -0.02em; filter: drop-shadow(0 0 8px rgba(255,255,255,0.2)); }')

# 8. Add status-glow-pulse animation
css = css.replace('.status-connecting  .status-dot { background: var(--warn); animation: pulse-yellow 2s infinite; }', '.status-connecting  .status-dot { background: var(--warn); animation: pulse-yellow 1.5s infinite; }\n.status-connected { animation: status-glow-pulse 3s infinite alternate; }\n@keyframes status-glow-pulse {\n  from { box-shadow: 0 0 10px rgba(0,229,160,0.1); }\n  to { box-shadow: 0 0 20px rgba(0,229,160,0.3); }\n}')

with open('static/style.css', 'w', encoding='utf-8') as f:
    f.write(css)

# BUMP VERSION
with open('ups_monitor.py', 'r', encoding='utf-8') as f:
    py = f.read()
py = py.replace('VERSION = "1.3.0"', 'VERSION = "2.0.0"')
with open('ups_monitor.py', 'w', encoding='utf-8') as f:
    f.write(py)

with open('templates/index.html', 'r', encoding='utf-8') as f:
    html = f.read()
html = html.replace('v1.3.0', 'v2.0.0')
with open('templates/index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print("Updates applied!")
