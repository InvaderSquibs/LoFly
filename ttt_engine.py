"""
Pure-Python tic-tac-toe engine. No brian2/connectome dependency so it can be
unit-tested fast and reused by the self-play driver.

Board: list of 9 ints. 0=empty, 1=fly(X), 2=opponent(O).
Cell indices:
    0 1 2
    3 4 5
    6 7 8
"""
import random

LINES = [
    (0, 1, 2), (3, 4, 5), (6, 7, 8),   # rows
    (0, 3, 6), (1, 4, 7), (2, 5, 8),   # cols
    (0, 4, 8), (2, 4, 6),              # diagonals
]


def new_board():
    return [0] * 9


def legal_moves(board):
    return [i for i, v in enumerate(board) if v == 0]


def winner(board):
    """Returns 1 or 2 if that player has a completed line, else 0."""
    for a, b, c in LINES:
        if board[a] != 0 and board[a] == board[b] == board[c]:
            return board[a]
    return 0


def is_draw(board):
    return winner(board) == 0 and all(v != 0 for v in board)


def game_over(board):
    w = winner(board)
    return (w != 0) or is_draw(board)


def opponent_move(board, rng=None):
    """Opponent plays uniformly at random among legal moves."""
    rng = rng or random
    return rng.choice(legal_moves(board))
