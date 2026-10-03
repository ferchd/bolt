"""Extract the checksum-verified Oracle test RPM using Python standard library."""
import gzip, lzma, bz2, struct, os, sys, stat

def header(stream):
    prefix = stream.read(16)
    assert prefix[:3] == b'\x8e\xad\xe8', 'Invalid RPM header'
    count, size = struct.unpack('>II', prefix[8:])
    indexes = [struct.unpack('>IIII', stream.read(16)) for _ in range(count)]
    data = stream.read(size)
    return {tag: data[offset:] for tag, kind, offset, count in indexes}

stream = open(sys.argv[1], 'rb')
stream.seek(96)
header(stream)
stream.seek((stream.tell() + 7) & ~7)
metadata = header(stream)
compressor = metadata[1125].split(b'\0')[0].decode()
print('RPM payload:', compressor, 'offset:', stream.tell(), flush=True)
if compressor == 'xz': payload = lzma.LZMAFile(stream)
elif compressor == 'gzip': payload = gzip.GzipFile(fileobj=stream)
elif compressor == 'bzip2': payload = bz2.BZ2File(stream)
else: raise RuntimeError('Unsupported compressor: ' + compressor)
root = os.path.abspath(sys.argv[2])
links = {}
pending = []
count = 0
def exact(size):
    value = payload.read(size)
    if len(value) != size: raise RuntimeError('Truncated RPM payload')
    return value
while True:
    prefix = exact(110)
    assert prefix[:6] in (b'070701', b'070702'), 'Invalid CPIO header'
    fields = [int(prefix[6 + 8*i:14 + 8*i], 16) for i in range(13)]
    ino, mode, uid, gid, nlink, mtime, size, major, minor, rmajor, rminor, namesize, check = fields
    name = exact(namesize).rstrip(b'\0').decode()
    exact((-110 - namesize) % 4)
    if name == 'TRAILER!!!': break
    normalized = name.removeprefix('./').lstrip('/')
    assert '..' not in normalized.split('/'), 'Unsafe RPM path'
    target = os.path.join(root, normalized)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if stat.S_ISDIR(mode):
        os.makedirs(target, exist_ok=True)
    elif stat.S_ISLNK(mode):
        link = exact(size).decode()
        if os.path.lexists(target): os.unlink(target)
        os.symlink(link, target)
    elif stat.S_ISREG(mode):
        key = (ino, major, minor)
        if nlink > 1 and size == 0:
            pending.append((target, key))
        else:
            with open(target, 'wb') as output:
                remaining = size
                while remaining:
                    part = exact(min(remaining, 1024 * 1024))
                    output.write(part); remaining -= len(part)
            os.chmod(target, mode & 0o7777)
            if nlink > 1: links[key] = target
    else:
        exact(size)
    exact((-size) % 4)
    count += 1
    if count % 1000 == 0: print('Extracted', count, flush=True)
for target, key in pending:
    if key in links: os.link(links[key], target)
    else: open(target, 'wb').close()
print('Extracted total', count, flush=True)
