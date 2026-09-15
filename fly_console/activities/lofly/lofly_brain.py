"""
LoFly Brian2 listening harness.

Current-song listening:
  chroma[12] → Poisson rates on 12 ORN glomeruli (pitch-class channels)
  runs MaleCNS-weighted LIF subgraph → ALPN / KC / MBON / DAN rates

Mix / harmonic-change signal:
  courtship_drive ∈ [0,1] → extra Poisson on pC1 / vPR6 / TN1
  (and a modest DAN boost) so strong Camelot+chroma motion activates
  courtship circuits while the fly is still "hearing" the incoming track.

Catalogue features for *other* tracks stay outside the network (selection
memory). Only the current listening stream + courtship drive enter Brian2.

  Requires: extract_subgraph.py feathers in this folder.
"""
from __future__ import annotations

import sys
from pathlib import Path
from textwrap import dedent

import numpy as np
import pandas as pd
from brian2 import (
    Hz,
    Network,
    NeuronGroup,
    PoissonInput,
    SpikeMonitor,
    Synapses,
    ms,
    mV,
)

ACTIVITY_DIR = Path(__file__).resolve().parent
REPO_ROOT = ACTIVITY_DIR.parents[2]

EDGES_PATH = ACTIVITY_DIR / "lofly_subgraph_edges.feather"
NODES_PATH = ACTIVITY_DIR / "lofly_subgraph_nodes.feather"
NT_PATH = REPO_ROOT / "body-neurotransmitters-male-cns-v1.0.feather"

if not EDGES_PATH.exists() or not NODES_PATH.exists():
    raise SystemExit(
        f"Missing subgraph feathers. Run:\n"
        f"  python3 {ACTIVITY_DIR / 'extract_subgraph.py'}"
    )

edges = pd.read_feather(EDGES_PATH)
nodes = pd.read_feather(NODES_PATH).drop_duplicates(subset="bodyId")
nt = pd.read_feather(NT_PATH)[["body", "consensus_nt"]]

CHROMA_PREFIXES = [f"chroma_{i}_" for i in range(12)]
COURTSHIP_GROUPS = ["courtship_pC1", "courtship_vPR6", "courtship_TN1"]
PATHWAY_GROUPS = ["ALPN", "Kenyon_Cell", "MBON", "DAN"]


def full_group_name(prefix, nodes_df):
    matches = [g for g in nodes_df["group"].unique() if g.startswith(prefix)]
    assert len(matches) == 1, (prefix, matches)
    return matches[0]


chroma_group_names = [full_group_name(p, nodes) for p in CHROMA_PREFIXES]
for g in COURTSHIP_GROUPS + PATHWAY_GROUPS:
    assert g in set(nodes["group"]), f"missing group {g}"

other_groups = [
    g
    for g in nodes["group"].unique()
    if g not in chroma_group_names and g not in COURTSHIP_GROUPS and g not in PATHWAY_GROUPS
]
group_order = chroma_group_names + COURTSHIP_GROUPS + PATHWAY_GROUPS + other_groups

ordered_ids, group_ranges = [], {}
for g in group_order:
    ids_g = sorted(nodes.loc[nodes["group"] == g, "bodyId"].tolist())
    group_ranges[g] = (len(ordered_ids), len(ordered_ids) + len(ids_g))
    ordered_ids.extend(ids_g)

node_ids = ordered_ids
id2idx = {b: i for i, b in enumerate(node_ids)}
N = len(node_ids)

nt_map = nt.set_index("body")["consensus_nt"].to_dict()


def sign_for(body_id):
    t = nt_map.get(body_id, "unclear")
    if t == "acetylcholine":
        return 1.0
    if t in ("gaba", "glutamate"):
        return -1.0
    return 1.0


pre_ids = edges["body_pre"].values
post_ids = edges["body_post"].values
counts = edges["weight"].values.astype(float)
signs = np.array([sign_for(b) for b in pre_ids])
i_pre = np.array([id2idx[b] for b in pre_ids])
i_post = np.array([id2idx[b] for b in post_ids])

params = dict(
    v_0=-52 * mV,
    v_rst=-52 * mV,
    v_th=-45 * mV,
    t_mbr=20 * ms,
    tau=5 * ms,
    t_rfc=2.2 * ms,
    t_dly=1.8 * ms,
    w_syn=0.275 * mV,
    f_poi=250,
)
eqs = dedent(
    """
    dv/dt = (v_0 - v + g) / t_mbr : volt (unless refractory)
    dg/dt = -g / tau               : volt (unless refractory)
    rfc                            : second
"""
)

# Chroma 0..1-ish → Hz. Peak ~220 Hz (matches TTT occupied-cell rate).
CHROMA_RATE_MAX = 220.0
COURTSHIP_RATE_MAX = {
    "courtship_pC1": 180.0,
    "courtship_vPR6": 160.0,
    "courtship_TN1": 140.0,
}
DAN_COURTSHIP_BONUS = 80.0  # extra Hz onto DAN when courtship_drive high
T_RUN_MS = 150.0

BIN_MS = 3.0
N_BINS = int(T_RUN_MS / BIN_MS)
SAMPLE_PER_GROUP = 40


def build_network():
    neu = NeuronGroup(
        N,
        model=eqs,
        method="linear",
        threshold="v > v_th",
        reset="v = v_rst; g = 0*mV",
        refractory="rfc",
        namespace=params,
        name="neurons",
    )
    neu.v = params["v_0"]
    neu.g = 0
    neu.rfc = params["t_rfc"]
    syn = Synapses(neu, neu, "w : volt", on_pre="g += w", delay=params["t_dly"])
    syn.connect(i=i_pre, j=i_post)
    syn.w = signs * counts * params["w_syn"]
    spk_mon = SpikeMonitor(neu)
    return neu, syn, spk_mon


def _add_poisson(net, neu, gname, rate_hz, pois_objs):
    if rate_hz <= 0:
        return
    start, stop = group_ranges[gname]
    if stop <= start:
        return
    p = PoissonInput(
        target=neu[start:stop],
        target_var="v",
        N=1,
        rate=rate_hz * Hz,
        weight=params["w_syn"] * params["f_poi"],
    )
    pois_objs.append(p)
    neu.rfc[start:stop] = 0 * ms


def chroma_to_rates(chroma) -> np.ndarray:
    """Normalize 12-D chroma to [0, CHROMA_RATE_MAX] Hz."""
    v = np.asarray(chroma, dtype=float).ravel()
    assert v.size == 12, v.shape
    mx = float(v.max()) if v.max() > 0 else 1.0
    return (v / mx) * CHROMA_RATE_MAX


def simulate_listening(chroma, courtship_drive: float = 0.0, seed=None, with_raster: bool = False):
    """
    Run one listening trial.

    chroma: length-12 vector (current song)
    courtship_drive: 0..1 from mix harmonic salience (0 while just listening
      mid-track; set high on transition moments)
    """
    if seed is not None:
        np.random.seed(seed)

    drive = float(max(0.0, min(1.0, courtship_drive)))
    rates = chroma_to_rates(chroma)

    neu, syn, spk_mon = build_network()
    net = Network(neu, syn, spk_mon)
    pois_objs = []

    for i, rate in enumerate(rates):
        _add_poisson(net, neu, chroma_group_names[i], float(rate), pois_objs)

    for gname, rmax in COURTSHIP_RATE_MAX.items():
        _add_poisson(net, neu, gname, drive * rmax, pois_objs)

    if drive > 0:
        _add_poisson(net, neu, "DAN", drive * DAN_COURTSHIP_BONUS, pois_objs)

    if pois_objs:
        net.add(*pois_objs)
    net.run(T_RUN_MS * ms)

    spike_trains = spk_mon.spike_trains()
    counts_per_neuron = np.zeros(N)
    for idx, times in spike_trains.items():
        counts_per_neuron[idx] = len(times)
    rate_hz = counts_per_neuron / (T_RUN_MS / 1000.0)

    def group_rate(gname):
        start, stop = group_ranges[gname]
        return float(rate_hz[start:stop].mean()) if stop > start else 0.0

    out = {
        "chroma_rates_hz": [float(x) for x in rates],
        "alpn_rate": group_rate("ALPN"),
        "kc_rate": group_rate("Kenyon_Cell"),
        "mbon_rate": group_rate("MBON"),
        "dan_rate": group_rate("DAN"),
        "courtship_pC1_rate": group_rate("courtship_pC1"),
        "courtship_vPR6_rate": group_rate("courtship_vPR6"),
        "courtship_TN1_rate": group_rate("courtship_TN1"),
        "courtship_drive": drive,
    }

    if with_raster:
        rate_curves = {}
        raster = {}
        for gname in PATHWAY_GROUPS:
            start, stop = group_ranges[gname]
            idxs = np.arange(start, stop)
            binned = np.zeros(N_BINS)
            for idx in idxs:
                times = spike_trains.get(idx, [])
                for t in times:
                    b = int((float(t) * 1000.0) / BIN_MS)
                    if 0 <= b < N_BINS:
                        binned[b] += 1
            n_group = max(1, stop - start)
            binned_hz = (binned / n_group) / (BIN_MS / 1000.0)
            rate_curves[gname] = [round(float(x), 2) for x in binned_hz]

            sample_idxs = (
                idxs
                if len(idxs) <= SAMPLE_PER_GROUP
                else np.linspace(start, stop - 1, SAMPLE_PER_GROUP).astype(int)
            )
            raster[gname] = []
            for ni, idx in enumerate(sample_idxs):
                times = spike_trains.get(int(idx), [])
                raster[gname].append(
                    {
                        "n": int(ni),
                        "t": [round(float(t) * 1000.0, 1) for t in times],
                    }
                )
        out["rate_curves"] = rate_curves
        out["raster"] = raster

    return out


def _smoke():
    chroma = np.array([0.1, 0.05, 0.2, 0.1, 0.4, 0.3, 0.1, 0.8, 0.2, 0.5, 0.1, 0.05])
    print(f"N={N} edges={len(edges)}")
    r0 = simulate_listening(chroma, courtship_drive=0.0, seed=1)
    r1 = simulate_listening(chroma, courtship_drive=0.85, seed=1)
    print("quiet courtship", {k: round(v, 2) if isinstance(v, float) else v for k, v in r0.items() if k.endswith("_rate") or k == "courtship_drive"})
    print("hot courtship ", {k: round(v, 2) if isinstance(v, float) else v for k, v in r1.items() if k.endswith("_rate") or k == "courtship_drive"})


if __name__ == "__main__":
    sys.path.insert(0, str(ACTIVITY_DIR))
    _smoke()
