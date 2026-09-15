"""
Train a linear readout on DOWNSTREAM firing rates (ALPN, Kenyon_Cell, MBON,
DAN, descending neurons -- NOT the stimulated ORNs themselves, which would
be a trivial/circular decode) to classify which real odor stimulus
(pheromone glomerulus DA1 vs food-odor glomerulus DL3) was presented.

The connectome's biological weights are completely untouched throughout --
only this readout is fit. Uses leave-one-out cross-validation since we only
have 20 trials.
"""
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import LeaveOneOut, cross_val_predict
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.metrics import accuracy_score, confusion_matrix

nodes = pd.read_feather('subgraph_nodes.feather').drop_duplicates(subset='bodyId')
trials = pd.read_feather('trial_rates.feather')

downstream_groups = ['ALPN', 'Kenyon_Cell', 'MBON', 'DAN', 'descending']
downstream_ids = nodes.loc[nodes['group'].isin(downstream_groups), 'bodyId'].tolist()
feature_cols = [f'body_{b}' for b in downstream_ids if f'body_{b}' in trials.columns]
print(f'Using {len(feature_cols)} downstream neurons as features '
      f'(excluding the {204+103} stimulated ORNs themselves)')

X = trials[feature_cols].values
y = trials['label'].values

clf = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0))

loo = LeaveOneOut()
y_pred = cross_val_predict(clf, X, y, cv=loo)
acc = accuracy_score(y, y_pred)
print(f'Leave-one-out accuracy: {acc:.3f}  ({(y==y_pred).sum()}/{len(y)} correct)')
print('Confusion matrix (rows=true, cols=pred):')
labels_sorted = sorted(set(y))
cm = confusion_matrix(y, y_pred, labels=labels_sorted)
print(pd.DataFrame(cm, index=labels_sorted, columns=labels_sorted))

# Per-group mean firing rate, to see where the discriminative signal lives
print()
print('Mean firing rate (Hz) per group, by stimulus class:')
for g in downstream_groups + ['stim_A_ORN_DA1', 'stim_B_ORN_DL3']:
    ids = nodes.loc[nodes['group'] == g, 'bodyId'].tolist()
    cols = [f'body_{b}' for b in ids if f'body_{b}' in trials.columns]
    if not cols:
        continue
    for cls in labels_sorted:
        m = trials.loc[trials['label'] == cls, cols].values.mean()
        print(f'  {g:16s} {cls:14s} mean_rate={m:7.2f} Hz  (n={len(cols)} neurons)')
