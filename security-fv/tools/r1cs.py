"""Minimal reader for circom's iden3 binary .r1cs and text .sym files."""
import struct
from dataclasses import dataclass, field

BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617


@dataclass
class R1CS:
    prime: int
    n_wires: int
    n_pub_out: int
    n_pub_in: int
    n_prv_in: int
    constraints: list = field(default_factory=list)  # [(A,B,C)], each {wire: coeff mod p}
    names: dict = field(default_factory=dict)         # wire id -> hierarchical signal name


def parse_r1cs(path):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:4] == b"r1cs", "bad magic"
    version, n_sections = struct.unpack_from("<II", data, 4)
    assert version == 1
    off = 12
    sections = {}
    for _ in range(n_sections):
        stype, ssize = struct.unpack_from("<IQ", data, off)
        off += 12
        sections[stype] = (off, ssize)
        off += ssize
    h, _ = sections[1]
    n8 = struct.unpack_from("<I", data, h)[0]
    prime = int.from_bytes(data[h + 4:h + 4 + n8], "little")
    n_wires, n_pub_out, n_pub_in, n_prv_in, _n_labels, m = struct.unpack_from("<IIIIQI", data, h + 4 + n8)
    r = R1CS(prime, n_wires, n_pub_out, n_pub_in, n_prv_in)
    c, _ = sections[2]
    p = c
    for _ in range(m):
        lcs = []
        for _ in range(3):
            (nt,) = struct.unpack_from("<I", data, p)
            p += 4
            lc = {}
            for _ in range(nt):
                (w,) = struct.unpack_from("<I", data, p)
                coeff = int.from_bytes(data[p + 4:p + 4 + n8], "little")
                p += 4 + n8
                lc[w] = (lc.get(w, 0) + coeff) % prime
            lcs.append({w: v for w, v in lc.items() if v})
        r.constraints.append(tuple(lcs))
    return r


def parse_sym(path, r1cs):
    """Attach wire names. Later (shorter-path) aliases do not overwrite the first label seen."""
    with open(path) as f:
        for line in f:
            lab, wid, _comp, name = line.rstrip("\n").split(",", 3)
            wid = int(wid)
            if wid >= 0 and wid not in r1cs.names:
                r1cs.names[wid] = name
    r1cs.names[0] = "ONE"
    return r1cs


def load(r1cs_path, sym_path):
    return parse_sym(sym_path, parse_r1cs(r1cs_path))
