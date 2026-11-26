# Drives the Even Hub simulator over its automation API and saves what the
# glasses show. Usage:
#   python tools/sim.py shot NAME            framebuffer -> shots/NAME.png (+ _view.png, 2x on black)
#   python tools/sim.py input ACTION [NAME]  click|double_click|up|down|long_press|long_press_release
#   python tools/sim.py console              print new console lines
import io, json, sys, time, urllib.request
from pathlib import Path
from PIL import Image

BASE = "http://127.0.0.1:9899"
SHOTS = Path(__file__).resolve().parent.parent / "shots"
SHOTS.mkdir(exist_ok=True)

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as r:
        return r.read()

def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()

def shot(name):
    im = Image.open(io.BytesIO(get("/api/screenshot/glasses"))).convert("RGBA")
    im.save(SHOTS / f"{name}.png")
    bg = Image.new("RGBA", im.size, (0, 0, 0, 255))
    bg.alpha_composite(im)
    bg.convert("RGB").resize((im.width * 2, im.height * 2), Image.NEAREST).save(SHOTS / f"{name}_view.png")
    lit = sum(1 for p in im.getdata() if p[3] > 0)
    print(f"{name}: {lit} lit px -> {SHOTS / (name + '_view.png')}")

def console_lines(since=0):
    d = json.loads(get(f"/api/console?since_id={since}"))
    for e in d.get("entries", []):
        print(e["id"], e["level"], e["message"][:200])

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "shot":
        shot(sys.argv[2])
    elif cmd == "input":
        post("/api/input", {"action": sys.argv[2]})
        time.sleep(float(sys.argv[4]) if len(sys.argv) > 4 else 1.2)
        if len(sys.argv) > 3:
            shot(sys.argv[3])
    elif cmd == "console":
        console_lines(int(sys.argv[2]) if len(sys.argv) > 2 else 0)
