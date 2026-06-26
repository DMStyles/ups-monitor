import hid
import time

def read_ups():
    vid, pid = 0x0665, 0x5161
    dev = hid.device()
    try:
        dev.open(vid, pid)
        dev.set_nonblocking(False)
        
        cmd = b'Q1\r'
        packet = b'\x00' + cmd + b'\x00' * (8 - len(cmd))
        dev.write(packet)
        time.sleep(0.5)
        
        res = b''
        for _ in range(50):
            data = dev.read(8, timeout_ms=200)
            if data:
                res += bytes(data)
                # Voltronic QS response usually starts with '(' and ends with '\r'
                if b'\r' in res and res.startswith(b'('):
                    break
        print(f'Final read result: {res}')
        
    except Exception as e:
        print('Error:', e)
    finally:
        dev.close()

read_ups()
