"""
Self-play driver V2: board-state-aware policy.

V1 (ttt_selfplay.py) learned a single global 9-value bias, added to the
connectome's move_rates regardless of board state -- the honest caveat was
that most of its win-rate gain came from finding good default cells, not
from the connectome's output actually discriminating between layouts.

V2 tests that directly: instead of one global bias, we keep a per-board-state
bias table (a plain bandit per exact board), folded through the 8 symmetries
of the 3x3 grid (rotations + reflections) so that games sharing a board up to
rotation/mirroring pool their learning. If V2's win rate clears V1's, the
gain is coming from real state-conditioning; if not, the connectome's
move-preference output genuinely doesn't discriminate board layouts much
more than V1 already extracted.

Checkpointed exactly like V1: policy + log saved after every game.
"""
import sys
import json
import time
import random
from pathlib import Path

import numpy as np

import ttt_engine as game
import ttt_brain as brain

POLICY_PATH = Path('ttt_policy_v2.json')
LOG_PATH = Path('ttt_game_log_v2.jsonl')

LR = 8.0
BIAS_CLIP = 60.0
EPS_START = 0.35
EPS_MIN = 0.05
EPS_DECAY = 0.985
REWARD = {'win': 1.0, 'loss': -1.0, 'draw': 0.0}

# --- 3x3 board symmetry group (dihedral D4): 8 transforms as cell permutations.
# perm[i] = index that cell i maps to under the transform.
def _perm_from_rc(fn):
    p = [0] * 9
    for r in range(3):
        for c in range(3):
            nr, nc = fn(r, c)
            p[r * 3 + c] = nr * 3 + nc
    return p

SYMMETRIES = [
    _perm_from_rc(lambda r, c: (r, c)),               # identity
    _perm_from_rc(lambda r, c: (c, 2 - r)),            # rot90 cw
    _perm_from_rc(lambda r, c: (2 - r, 2 - c)),         # rot180
    _perm_from_rc(lambda r, c: (2 - c, r)),             # rot270 cw
    _perm_from_rc(lambda r, c: (r, 2 - c)),             # mirror horizontal
    _perm_from_rc(lambda r, c: (2 - r, c)),             # mirror vertical
    _perm_from_rc(lambda r, c: (c, r)),                 # transpose
    _perm_from_rc(lambda r, c: (2 - c, 2 - r)),         # anti-transpose
]


def apply_perm(board, perm):
    out = [0] * 9
    for i in range(9):
        out[perm[i]] = board[i]
    return out


def canonicalize(board):
    """Returns (canonical_key, perm) where perm maps a real cell index i to
    its index in the canonical board, i.e. canonical[perm[i]] == board[i]."""
    best_key = None
    best_perm = None
    for perm in SYMMETRIES:
        cand = apply_perm(board, perm)
        key = ''.join(str(v) for v in cand)
        if best_key is None or key < best_key:
            best_key = key
            best_perm = perm
    return best_key, best_perm


def load_policy():
    if POLICY_PATH.exists():
        with open(POLICY_PATH) as f:
            return json.load(f)
    return dict(table={}, games_played=0, wins=0, losses=0, draws=0,
                lr=LR, eps_start=EPS_START, eps_min=EPS_MIN, eps_decay=EPS_DECAY)


def save_policy(policy):
    tmp = POLICY_PATH.with_suffix('.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(policy, f)
    tmp.replace(POLICY_PATH)


def get_bias(policy, canon_key):
    return policy['table'].get(canon_key, [0.0] * 9)


def current_epsilon(policy):
    return max(EPS_MIN, EPS_START * (EPS_DECAY ** policy['games_played']))


def choose_fly_move(board, policy, rng):
    sim = brain.simulate_board(board)
    move_rates = np.asarray(sim['move_rates'], dtype=float)
    canon_key, perm = canonicalize(board)
    bias_canon = np.asarray(get_bias(policy, canon_key), dtype=float)
    # bias for real cell i is bias_canon[perm[i]]
    bias_real = np.array([bias_canon[perm[i]] for i in range(9)])
    scores = move_rates + bias_real
    legal = game.legal_moves(board)
    eps = current_epsilon(policy)
    if rng.random() < eps:
        move = rng.choice(legal)
        exploratory = True
    else:
        legal_scores = [(scores[m], m) for m in legal]
        best_score = max(s for s, _ in legal_scores)
        best_moves = [m for s, m in legal_scores if s == best_score]
        move = rng.choice(best_moves)
        exploratory = False
    return move, eps, exploratory, canon_key, perm


def play_game(policy, rng):
    board = game.new_board()
    fly_moves, opp_moves = [], []
    fly_canon_updates = []  # list of (canon_key, canon_move_idx)
    turn = 1
    eps_used = None
    n_exploratory = 0
    while not game.game_over(board):
        if turn == 1:
            move, eps, exploratory, canon_key, perm = choose_fly_move(board, policy, rng)
            eps_used = eps
            n_exploratory += int(exploratory)
            fly_canon_updates.append((canon_key, perm[move]))
            board[move] = 1
            fly_moves.append(move)
        else:
            move = game.opponent_move(board, rng)
            board[move] = 2
            opp_moves.append(move)
        turn = 2 if turn == 1 else 1

    w = game.winner(board)
    outcome = 'win' if w == 1 else ('loss' if w == 2 else 'draw')
    return dict(fly_moves=fly_moves, opp_moves=opp_moves, final_board=board,
                outcome=outcome, epsilon_used=eps_used, n_exploratory=n_exploratory,
                fly_canon_updates=fly_canon_updates)


def update_policy(policy, result):
    reward = REWARD[result['outcome']]
    if reward != 0.0:
        for canon_key, canon_move in result['fly_canon_updates']:
            bias = policy['table'].get(canon_key, [0.0] * 9)
            bias[canon_move] = float(np.clip(bias[canon_move] + LR * reward, -BIAS_CLIP, BIAS_CLIP))
            policy['table'][canon_key] = bias
    policy['games_played'] += 1
    policy[{'win': 'wins', 'loss': 'losses', 'draw': 'draws'}[result['outcome']]] += 1
    return policy


def append_log(entry):
    with open(LOG_PATH, 'a') as f:
        f.write(json.dumps(entry) + '\n')


def main():
    n_games = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    time_budget_s = float(sys.argv[2]) if len(sys.argv) > 2 else 95.0

    rng = random.Random()
    policy = load_policy()
    t_start = time.time()
    completed = 0

    for g in range(n_games):
        if time.time() - t_start > time_budget_s:
            print(f'[budget] stopping early after {completed}/{n_games} games '
                  f'({time.time() - t_start:.1f}s elapsed)')
            break
        t_g0 = time.time()
        result = play_game(policy, rng)
        policy = update_policy(policy, result)
        save_policy(policy)
        append_log(dict(
            game_idx=policy['games_played'] - 1,
            outcome=result['outcome'],
            fly_moves=result['fly_moves'],
            opp_moves=result['opp_moves'],
            final_board=result['final_board'],
            epsilon_used=result['epsilon_used'],
            n_exploratory=result['n_exploratory'],
            t_wall_s=round(time.time() - t_g0, 2),
        ))
        completed += 1
        wr = policy['wins'] / max(1, policy['games_played'])
        n_states = len(policy['table'])
        print(f"game {policy['games_played']:4d}  outcome={result['outcome']:5s}  "
              f"eps={result['epsilon_used']:.3f}  win_rate={wr:.3f}  "
              f"n_canon_states_seen={n_states}  ({time.time()-t_g0:.1f}s)")

    print(f'--- done: {completed} games this run, {policy["games_played"]} total '
          f'(W={policy["wins"]} L={policy["losses"]} D={policy["draws"]}), '
          f'{len(policy["table"])} distinct canonical states in table ---')


if __name__ == '__main__':
    main()
