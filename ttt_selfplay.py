"""
Self-play driver: fly (real MaleCNS connectome + persisted learned bias) vs.
a random-legal-move opponent. Online reward learning: after every completed
game, the bias for each cell the fly played is nudged toward whatever just
happened (win: reinforce, loss: discourage, draw: no change) using a simple
bandit-style update. State is persisted to disk so learning carries across
runs/sessions.

Chunked-execution note: each board evaluation runs a full spiking simulation
of the real connectome (~2-3s), and each game needs a handful of fly moves,
so this script processes a small number of games per invocation and
checkpoints (policy + log) after EVERY game, never holding unsaved progress.

Usage: python3 ttt_selfplay.py [n_games] [time_budget_seconds]
"""
import sys
import json
import time
import random
from pathlib import Path

import numpy as np

import ttt_engine as game
import ttt_brain as brain

POLICY_PATH = Path('ttt_policy.json')
LOG_PATH = Path('ttt_game_log.jsonl')

LR = 8.0                 # bias learning rate (Hz) per game outcome
BIAS_CLIP = 60.0          # keep bias in a sane range vs. move_rates (0-200ish Hz)
EPS_START = 0.35
EPS_MIN = 0.05
EPS_DECAY = 0.985         # eps = max(EPS_MIN, EPS_START * EPS_DECAY**games_played)
REWARD = {'win': 1.0, 'loss': -1.0, 'draw': 0.0}


def load_policy():
    if POLICY_PATH.exists():
        with open(POLICY_PATH) as f:
            return json.load(f)
    return dict(bias=[0.0] * 9, games_played=0, wins=0, losses=0, draws=0,
                lr=LR, eps_start=EPS_START, eps_min=EPS_MIN, eps_decay=EPS_DECAY)


def save_policy(policy):
    tmp = POLICY_PATH.with_suffix('.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(policy, f, indent=2)
    tmp.replace(POLICY_PATH)


def current_epsilon(policy):
    return max(EPS_MIN, EPS_START * (EPS_DECAY ** policy['games_played']))


def choose_fly_move(board, policy, rng):
    sim = brain.simulate_board(board)
    move_rates = np.asarray(sim['move_rates'], dtype=float)
    bias = np.asarray(policy['bias'], dtype=float)
    scores = move_rates + bias
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
    return move, eps, exploratory, sim


def play_game(policy, rng):
    board = game.new_board()
    fly_moves, opp_moves = [], []
    turn = 1  # fly (X) always moves first
    eps_used = None
    n_exploratory = 0
    while not game.game_over(board):
        if turn == 1:
            move, eps, exploratory, _sim = choose_fly_move(board, policy, rng)
            eps_used = eps
            n_exploratory += int(exploratory)
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
                outcome=outcome, epsilon_used=eps_used, n_exploratory=n_exploratory)


def update_policy(policy, result):
    reward = REWARD[result['outcome']]
    bias = np.asarray(policy['bias'], dtype=float)
    if reward != 0.0:
        for c in result['fly_moves']:
            bias[c] += LR * reward
        bias = np.clip(bias, -BIAS_CLIP, BIAS_CLIP)
    policy['bias'] = bias.tolist()
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
        print(f"game {policy['games_played']:4d}  outcome={result['outcome']:5s}  "
              f"eps={result['epsilon_used']:.3f}  win_rate={wr:.3f}  "
              f"bias={[round(b,1) for b in policy['bias']]}  "
              f"({time.time()-t_g0:.1f}s)")

    print(f'--- done: {completed} games this run, {policy["games_played"]} total '
          f'(W={policy["wins"]} L={policy["losses"]} D={policy["draws"]}) ---')


if __name__ == '__main__':
    main()
