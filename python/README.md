# sandboxrouter (Python)

Python client for the [sandboxrouter](../README.md) HTTP API. Standard library only.

```bash
SANDBOXROUTER_TOKEN=secret npx @sandboxrouter/sdk serve   # holds your provider keys
pip install ./python
```

```python
from sandboxrouter import Client

sr = Client("http://127.0.0.1:8787", token="secret")

with sr.create(strategy="cheapest") as sbx:
    print(sbx.provider, sbx.estimated_hourly_usd)
    sbx.write_file("/tmp/hello.py", "print('hi')")
    r = sbx.exec("python3 /tmp/hello.py", on_stdout=lambda c: print(c, end=""))
    print(r.exit_code)

desk = sr.computer(os="linux", external_user_id="user_42")
desk.act("left_click", coordinate=[412, 230])
open("screen.png", "wb").write(desk.screenshot())
print(desk.viewer("control", reason="please log in")["url"])
```
