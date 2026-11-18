#!/usr/bin/env python3
"""ForgeDeck — TCP → 本地 PTY 桥

把远端（bridge 暴露的）裸 TCP 串口流映射成一个本地伪终端，
这样 PlatformIO / esptool / avrdude 只要 "一个串口路径" 就能用，
监控也复用同一套串口代码。

用法: pty_bridge.py TCP_HOST TCP_PORT LINK_PATH
"""
import errno
import os
import pty
import select
import socket
import time
import sys
import tty


def main() -> int:
    if len(sys.argv) < 4:
        sys.stderr.write("usage: pty_bridge.py HOST PORT LINK_PATH\n")
        return 2
    host, port, link = sys.argv[1], int(sys.argv[2]), sys.argv[3]

    master, slave = pty.openpty()
    try:
        tty.setraw(slave)
    except Exception:
        pass
    pts = os.ttyname(slave)

    try:
        os.unlink(link)
    except FileNotFoundError:
        pass
    os.symlink(pts, link)
    sys.stderr.write(f"pty {pts} -> {link}\n")
    sys.stderr.flush()

    # 对端 bridge 可能还没起来：重试连接，期间保持 PTY 存在
    deadline = time.time() + 120
    sock = None
    while time.time() < deadline:
        try:
            sock = socket.create_connection((host, port), timeout=4)
            break
        except OSError as e:
            sys.stderr.write(f"connect {host}:{port} failed: {e}; retry\n")
            sys.stderr.flush()
            time.sleep(2)
    if sock is None:
        sys.stderr.write("give up connecting\n")
        try:
            os.unlink(link)
        except OSError:
            pass
        return 1
    sock.setblocking(False)

    try:
        while True:
            r, _, _ = select.select([master, sock], [], [], 60)
            if not r:
                # 空闲超时只用于检查存活，不主动断开
                continue
            for src in r:
                if src is master:
                    try:
                        data = os.read(master, 4096)
                    except OSError as e:
                        if e.errno == errno.EIO:
                            return 0
                        raise
                    if not data:
                        return 0
                    try:
                        sock.sendall(data)
                    except (BrokenPipeError, ConnectionResetError):
                        return 0
                else:
                    try:
                        data = sock.recv(4096)
                    except BlockingIOError:
                        continue
                    except (ConnectionResetError, OSError):
                        return 0
                    if not data:
                        return 0
                    os.write(master, data)
    except KeyboardInterrupt:
        return 0
    finally:
        try:
            os.unlink(link)
        except OSError:
            pass
        try:
            sock.close()
        except Exception:
            pass
        try:
            os.close(master)
            os.close(slave)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
