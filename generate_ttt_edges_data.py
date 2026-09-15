"""
Build a static (state-independent) "backbone" edge list for the 3D view:
real synapses between neurons that both have a renderable 3D point (either a
real traced soma, or one of the 9 ORN input hub points). Ranked by synapse
weight and capped for a legible, performant render -- this is real wiring,
just the strongest slice of it, not a per-state computation (activity/flash
timing is driven separately by each neuron's own spike times at render time).
"""
import json
import pandas as pd
import numpy as np

import ttt_brain as brain

with open('ttt_3d_data.json') as f:
    d3 = json.load(f)

located_idx_sorted = sorted(int(k) for k in d3['positions'].keys())
idx_to_pointpos = {idx: i for i, idx in enumerate(located_idx_sorted)}
N_MAIN = len(located_idx_sorted)

hub_name_to_pointpos = {name: N_MAIN + j for j, name in enumerate(brain.cell_group_names)}
cell_ranges = {g: brain.group_ranges[g] for g in brain.cell_group_names}


def hub_of(idx):
    for g, (s, e) in cell_ranges.items():
        if s <= idx < e:
            return g
    return None


edges = pd.read_feather('ttt_subgraph_edges.feather')
id2idx = brain.id2idx
pre_idx_arr = edges['body_pre'].map(id2idx).values
post_idx_arr = edges['body_post'].map(id2idx).values
weight_arr = edges['weight'].values.astype(float)

internal = []  # (pre_point, post_point, weight)
by_hub = {g: [] for g in brain.cell_group_names}

for pre_idx, post_idx, w in zip(pre_idx_arr, post_idx_arr, weight_arr):
    post_p = idx_to_pointpos.get(int(post_idx))
    if post_p is None:
        continue
    if int(pre_idx) in idx_to_pointpos:
        internal.append((idx_to_pointpos[int(pre_idx)], post_p, w))
    else:
        g = hub_of(int(pre_idx))
        if g is not None:
            by_hub[g].append((hub_name_to_pointpos[g], post_p, w))

internal.sort(key=lambda t: -t[2])
internal_top = internal[:6000]

hub_top = []
for g, lst in by_hub.items():
    lst.sort(key=lambda t: -t[2])
    hub_top.extend(lst[:400])

print(f'internal candidates {len(internal)} -> kept {len(internal_top)}')
print(f'hub candidates {sum(len(v) for v in by_hub.values())} -> kept {len(hub_top)}')

def pack(lst, kind):
    return [[p, q, round(float(w), 1), kind] for p, q, w in lst]

edge_list = pack(internal_top, 'i') + pack(hub_top, 'h')
maxw = max(e[2] for e in edge_list)
print('total edges kept', len(edge_list), 'max weight', maxw)

out = {'edges': edge_list, 'n_main': N_MAIN, 'max_weight': maxw}
with open('ttt_edges_data.json', 'w') as f:
    json.dump(out, f)

import os
print('wrote ttt_edges_data.json', os.path.getsize('ttt_edges_data.json'), 'bytes')
