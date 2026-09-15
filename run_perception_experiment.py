"""
Perception/decoding experiment on the MaleCNS v1.0 connectome subgraph.

Stimulate two real, distinct olfactory-receptor-neuron populations
(ORN_DA1 = pheromone/cVA glomerulus, ORN_DL3 = food-odor glomerulus) with
independent Poisson trials, let activity propagate through the REAL
connectome weights (antennal-lobe PNs -> Kenyon cells -> MBONs -> descending
neurons), then train a linear readout on downstream firing rates to decode
which odor was presented. The biological connectivity/weights are never
altered -- only the readout is trained. This mirrors the model in
Shiu et al. (Nature 2024) but applied to the newly released male CNS data.
"""
import time
import numpy as np
import pandas as pd
from textwrap import dedent

from brian2 import (NeuronGroup, Synapses, PoissonInput, SpikeMonitor,
                     Network, mV, ms, Hz, defaultclock)

t0 = time.time()

# ---------------------------------------------------------------
# Load subgraph + neurotransmitter sign
# ---------------------------------------------------------------
edges = pd.read_feather('subgraph_edges.feather')
nodes = pd.read_feather('subgraph_nodes.feather')
nt = pd.read_feather('body-neurotransmitters-male-cns-v1.0.feather')[['body', 'consensus_nt']]

# Order node_ids so each stimulus group occupies a CONTIGUOUS index block --
# Brian2 subgroups (used for a single batched PoissonInput) require
# contiguous indices, and one PoissonInput over a slice is far faster than
# one PoissonInput per neuron (avoids per-object Python-level overhead each
# timestep).
group_order = ['stim_A_ORN_DA1', 'stim_B_ORN_DL3']
nodes_dedup = nodes.drop_duplicates(subset='bodyId')
ordered_ids = []
group_ranges = {}
for g in group_order:
    ids_g = sorted(nodes_dedup.loc[nodes_dedup['group'] == g, 'bodyId'].tolist())
    group_ranges[g] = (len(ordered_ids), len(ordered_ids) + len(ids_g))
    ordered_ids.extend(ids_g)
remaining = sorted(set(nodes_dedup['bodyId']) - set(ordered_ids))
ordered_ids.extend(remaining)

node_ids = ordered_ids
id2idx = {b: i for i, b in enumerate(node_ids)}
N = len(node_ids)
print(f'N neurons = {N}, N synapse-rows = {len(edges)}')

group_of = nodes.set_index('bodyId')['group'].to_dict()

nt_map = nt.set_index('body')['consensus_nt'].to_dict()
def sign_for(body_id):
    t = nt_map.get(body_id, 'unclear')
    if t == 'acetylcholine':
        return 1.0
    if t in ('gaba', 'glutamate'):
        return -1.0
    return 1.0  # dopamine/octopamine/serotonin/unclear -> default excitatory

pre_ids = edges['body_pre'].values
post_ids = edges['body_post'].values
counts = edges['weight'].values.astype(float)

signs = np.array([sign_for(b) for b in pre_ids])
i_pre = np.array([id2idx[b] for b in pre_ids])
i_post = np.array([id2idx[b] for b in post_ids])

# ---------------------------------------------------------------
# Brian2 model (Shiu et al. 2024 parameterization)
# ---------------------------------------------------------------
params = dict(
    v_0=-52 * mV, v_rst=-52 * mV, v_th=-45 * mV, t_mbr=20 * ms,
    tau=5 * ms, t_rfc=2.2 * ms, t_dly=1.8 * ms,
    w_syn=0.275 * mV, r_poi=150 * Hz, f_poi=250,
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

def run_trial(stim_group_name, r_poi_hz, t_run_ms, seed):
    np.random.seed(seed)
    neu, syn, spk_mon = build_network()
    start, stop = group_ranges[stim_group_name]
    net = Network(neu, syn, spk_mon)
    pois = PoissonInput(target=neu[start:stop], target_var='v', N=1,
                         rate=r_poi_hz * Hz, weight=params['w_syn'] * params['f_poi'])
    neu.rfc[start:stop] = 0 * ms
    net.add(pois)
    net.run(t_run_ms * ms)
    counts_per_neuron = np.zeros(N)
    for idx, times in spk_mon.spike_trains().items():
        counts_per_neuron[idx] = len(times)
    rate_hz = counts_per_neuron / (t_run_ms / 1000.0)
    return rate_hz

if __name__ == '__main__':
    import sys
    n_trials_per_class = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    t_run_ms = float(sys.argv[2]) if len(sys.argv) > 2 else 300.0

    records = []
    labels = []
    trial_i = 0
    for cls, grp in [('A_pheromone', 'stim_A_ORN_DA1'), ('B_food_odor', 'stim_B_ORN_DL3')]:
        for k in range(n_trials_per_class):
            tt = time.time()
            rates = run_trial(grp, r_poi_hz=150, t_run_ms=t_run_ms, seed=1000 + trial_i)
            records.append(rates)
            labels.append(cls)
            print(f'  trial {trial_i}: class={cls} elapsed={time.time()-tt:.1f}s total_spikes={rates.sum()*t_run_ms/1000:.0f}')
            trial_i += 1

    rates_mat = np.vstack(records)
    labels = np.array(labels)

    df_out = pd.DataFrame(rates_mat, columns=[f'body_{b}' for b in node_ids])
    df_out['label'] = labels
    df_out.to_feather('trial_rates.feather')

    print(f'TOTAL elapsed: {time.time()-t0:.1f}s')
    print('Saved trial_rates.feather:', df_out.shape)
