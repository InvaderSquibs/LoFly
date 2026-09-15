"""
Generate 3D spatial + per-neuron spiking data for the tic-tac-toe fly-brain,
for the same 7 board states already used by the 2D visualizer (so both panels
stay in sync when stepping through a replay).

Real anatomy: every ALPN / Kenyon_Cell / MBON / DAN / descending(move) neuron
in the subgraph carries its actual traced soma 3D location (MaleCNS v1.0
annotations). The 9 ORN input populations have NO traced soma (their cell
bodies sit in the antenna, outside the imaged CNS volume) -- for those we
render one honest stand-in point per glomerulus: the synapse-weighted
centroid of that ORN group's real, located downstream partners (i.e. roughly
where its axon terminal/glomerulus actually sits in the antennal lobe).
"""
import json
import numpy as np
import pandas as pd
from brian2 import Network, PoissonInput, ms, Hz

import ttt_brain as brain

OUT_PATH = 'ttt_3d_data.json'

ann = pd.read_feather('body-annotations-male-cns-v1.0-minconf-0.5.feather')[['bodyId', 'somaLocation']]
loc_map = ann.set_index('bodyId')['somaLocation'].to_dict()


def get_loc(bid):
    v = loc_map.get(bid)
    if v is not None and hasattr(v, '__len__'):
        return [float(v[0]), float(v[1]), float(v[2])]
    return None


positions = [get_loc(b) for b in brain.node_ids]
n_located = sum(1 for p in positions if p is not None)
print(f'{n_located}/{brain.N} neurons have a real traced soma location')

edges = pd.read_feather('ttt_subgraph_edges.feather')
orn_hub_pos = {}
for g in brain.cell_group_names:
    start, stop = brain.group_ranges[g]
    ids = set(brain.node_ids[start:stop])
    sub = edges[edges['body_pre'].isin(ids)]
    pts, wts = [], []
    for p, wt in zip(sub['body_post'].values, sub['weight'].values.astype(float)):
        loc = get_loc(p)
        if loc is not None:
            pts.append(loc)
            wts.append(wt)
    pts = np.array(pts)
    wts = np.array(wts)
    centroid = (pts * wts[:, None]).sum(axis=0) / wts.sum()
    orn_hub_pos[g] = [round(float(c), 1) for c in centroid]
    print(f'  {g}: centroid from {len(pts)} located downstream synapse-partners')

BOARD_STATES = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 2, 0, 0, 0],
    [0, 1, 0, 2, 1, 2, 0, 0, 0],
    [0, 0, 0, 0, 0, 2, 1, 0, 0],
    [0, 1, 0, 2, 0, 2, 1, 0, 0],
    [0, 0, 0, 0, 0, 2, 0, 1, 0],
    [0, 1, 0, 2, 0, 2, 0, 1, 0],
]


def board_key(b):
    return ''.join(str(v) for v in b)


def simulate_neuron_spikes(board):
    neu, syn, spk_mon = brain.build_network()
    net = Network(neu, syn, spk_mon)
    pois_objs = []
    for i, state in enumerate(board):
        rate = brain.RATE_EMPTY if state == 0 else (brain.RATE_FLY if state == 1 else brain.RATE_OPP)
        if rate <= 0:
            continue
        start, stop = brain.group_ranges[brain.cell_group_names[i]]
        p = PoissonInput(target=neu[start:stop], target_var='v', N=1, rate=rate * Hz,
                          weight=brain.params['w_syn'] * brain.params['f_poi'])
        pois_objs.append(p)
        neu.rfc[start:stop] = 0 * ms
    if pois_objs:
        net.add(*pois_objs)
    net.run(brain.T_RUN_MS * ms)

    spike_trains = spk_mon.spike_trains()
    out_spikes, out_rate = {}, {}
    for idx in range(brain.N):
        if positions[idx] is None:
            continue
        times = spike_trains.get(idx, [])
        if len(times):
            out_spikes[idx] = [round(float(t) * 1000.0, 1) for t in times]
        r = len(times) / (brain.T_RUN_MS / 1000.0)
        if r > 0:
            out_rate[idx] = round(r, 2)
    return out_spikes, out_rate


data = {
    'positions': {str(i): [round(p[0], 1), round(p[1], 1), round(p[2], 1)]
                  for i, p in enumerate(positions) if p is not None},
    'orn_hub_positions': orn_hub_pos,
    'group_order': brain.group_order,
    'group_ranges': {g: list(r) for g, r in brain.group_ranges.items()},
    'cell_group_names': brain.cell_group_names,
    'move_group_names': brain.move_group_names,
    'states': {},
}

for board in BOARD_STATES:
    key = board_key(board)
    spikes, rates = simulate_neuron_spikes(board)
    data['states'][key] = {'spikes': spikes, 'rates': rates}
    print(f'{key}: {len(spikes)} located neurons spiked, {len(rates)} located neurons had r>0')

with open(OUT_PATH, 'w') as f:
    json.dump(data, f)

import os
print('wrote', OUT_PATH, os.path.getsize(OUT_PATH), 'bytes')
