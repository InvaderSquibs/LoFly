"""
Core simulation harness for fly-brain tic-tac-toe: encodes a board state as
Poisson stimulation of 9 real ORN glomeruli (one per cell), runs the real
MaleCNS connectome-weighted LIF network, and reads move preference off 9
real descending-neuron types (one per possible move).
"""
import numpy as np
import pandas as pd
from textwrap import dedent
from brian2 import (NeuronGroup, Synapses, PoissonInput, SpikeMonitor,
                     Network, mV, ms, Hz)

edges = pd.read_feather('ttt_subgraph_edges.feather')
nodes = pd.read_feather('ttt_subgraph_nodes.feather').drop_duplicates(subset='bodyId')
nt = pd.read_feather('body-neurotransmitters-male-cns-v1.0.feather')[['body', 'consensus_nt']]

CELL_GROUPS = [f'cell_{i}_' for i in range(9)]
MOVE_GROUPS = [f'move_{i}_' for i in range(9)]

def full_group_name(prefix, nodes_df):
    matches = [g for g in nodes_df['group'].unique() if g.startswith(prefix)]
    assert len(matches) == 1, (prefix, matches)
    return matches[0]

cell_group_names = [full_group_name(p, nodes) for p in CELL_GROUPS]
move_group_names = [full_group_name(p, nodes) for p in MOVE_GROUPS]
other_groups = [g for g in nodes['group'].unique() if g not in cell_group_names and g not in move_group_names]

group_order = cell_group_names + move_group_names + other_groups
ordered_ids, group_ranges = [], {}
for g in group_order:
    ids_g = sorted(nodes.loc[nodes['group'] == g, 'bodyId'].tolist())
    group_ranges[g] = (len(ordered_ids), len(ordered_ids) + len(ids_g))
    ordered_ids.extend(ids_g)

node_ids = ordered_ids
id2idx = {b: i for i, b in enumerate(node_ids)}
N = len(node_ids)
group_of = nodes.set_index('bodyId')['group'].to_dict()
print(f'N neurons = {N}, N synapse-rows = {len(edges)}, cells={cell_group_names}, moves={move_group_names}')

nt_map = nt.set_index('body')['consensus_nt'].to_dict()
def sign_for(body_id):
    t = nt_map.get(body_id, 'unclear')
    if t == 'acetylcholine':
        return 1.0
    if t in ('gaba', 'glutamate'):
        return -1.0
    return 1.0

pre_ids = edges['body_pre'].values
post_ids = edges['body_post'].values
counts = edges['weight'].values.astype(float)
signs = np.array([sign_for(b) for b in pre_ids])
i_pre = np.array([id2idx[b] for b in pre_ids])
i_post = np.array([id2idx[b] for b in post_ids])

params = dict(
    v_0=-52 * mV, v_rst=-52 * mV, v_th=-45 * mV, t_mbr=20 * ms,
    tau=5 * ms, t_rfc=2.2 * ms, t_dly=1.8 * ms,
    w_syn=0.275 * mV, f_poi=250,
)
eqs = dedent('''
    dv/dt = (v_0 - v + g) / t_mbr : volt (unless refractory)
    dg/dt = -g / tau               : volt (unless refractory)
    rfc                            : second
''')

def build_network():
    neu = NeuronGroup(N, model=eqs, method='linear', threshold='v > v_th',
                       reset='v = v_rst; g = 0*mV', refractory='rfc',
                       namespace=params, name='neurons')
    neu.v = params['v_0']
    neu.g = 0
    neu.rfc = params['t_rfc']
    syn = Synapses(neu, neu, 'w : volt', on_pre='g += w', delay=params['t_dly'])
    syn.connect(i=i_pre, j=i_post)
    syn.w = signs * counts * params['w_syn']
    spk_mon = SpikeMonitor(neu)
    return neu, syn, spk_mon

# rate (Hz) encoding of board cell state
RATE_EMPTY = 0.0
RATE_OPP = 110.0
RATE_FLY = 220.0
T_RUN_MS = 150.0

def simulate_board(board, seed=None):
    """board: list of 9 ints, 0=empty 1=fly(X) 2=opp(O). Returns dict of
    move_rate_hz (len 9), dan_rate_hz, kc_rate_hz, mbon_rate_hz, alpn_rate_hz."""
    if seed is not None:
        np.random.seed(seed)
    neu, syn, spk_mon = build_network()
    net = Network(neu, syn, spk_mon)
    pois_objs = []
    for i, state in enumerate(board):
        rate = RATE_EMPTY if state == 0 else (RATE_FLY if state == 1 else RATE_OPP)
        if rate <= 0:
            continue
        start, stop = group_ranges[cell_group_names[i]]
        p = PoissonInput(target=neu[start:stop], target_var='v', N=1,
                          rate=rate * Hz, weight=params['w_syn'] * params['f_poi'])
        pois_objs.append(p)
        neu.rfc[start:stop] = 0 * ms
    if pois_objs:
        net.add(*pois_objs)
    net.run(T_RUN_MS * ms)

    counts_per_neuron = np.zeros(N)
    spike_trains = spk_mon.spike_trains()
    for idx, times in spike_trains.items():
        counts_per_neuron[idx] = len(times)
    rate_hz_per_neuron = counts_per_neuron / (T_RUN_MS / 1000.0)

    def group_rate(gname):
        start, stop = group_ranges[gname]
        return float(rate_hz_per_neuron[start:stop].mean()) if stop > start else 0.0

    move_rates = np.array([group_rate(g) for g in move_group_names])
    dan_rate = group_rate('DAN')
    kc_rate = group_rate('Kenyon_Cell')
    mbon_rate = group_rate('MBON')
    alpn_rate = group_rate('ALPN')
    return dict(move_rates=move_rates, dan_rate=dan_rate, kc_rate=kc_rate,
                mbon_rate=mbon_rate, alpn_rate=alpn_rate)
