export const turnBasedGames = ['tic-tac-toe', 'connect-four', 'dots-and-boxes']
export const scoreDuelGames = ['air-hockey', 'burger-stacker']
export const supportedGames = [...turnBasedGames, ...scoreDuelGames]

export function createTurnGameState(game) {
  if (game === 'tic-tac-toe') {
    return { game, status: 'active', currentTurn: 0, board: Array(9).fill(null), winner: null }
  }
  if (game === 'connect-four') {
    return { game, status: 'active', currentTurn: 0, board: Array.from({ length: 6 }, () => Array(7).fill(null)), winner: null }
  }
  if (game === 'dots-and-boxes') {
    return {
      game,
      status: 'active',
      currentTurn: 0,
      horizontal: Array.from({ length: 4 }, () => Array(3).fill(null)),
      vertical: Array.from({ length: 3 }, () => Array(4).fill(null)),
      boxes: Array.from({ length: 3 }, () => Array(3).fill(null)),
      scores: [0, 0],
      winner: null,
    }
  }
  return null
}

function getTicTacToeWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ]
  for (const [a, b, c] of lines) {
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) return board[a]
  }
  return null
}

function connectFourWinner(board, row, column, player) {
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]]
  return directions.some(([dr, dc]) => {
    let count = 1
    for (const sign of [-1, 1]) {
      let r = row + dr * sign
      let c = column + dc * sign
      while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r][c] === player) {
        count += 1
        r += dr * sign
        c += dc * sign
      }
    }
    return count >= 4
  })
}

function boxEdgesComplete(state, row, column) {
  return state.horizontal[row][column] !== null
    && state.horizontal[row + 1][column] !== null
    && state.vertical[row][column] !== null
    && state.vertical[row][column + 1] !== null
}

export function applyTurnMove(state, playerIndex, move) {
  if (!state || state.status !== 'active' || state.currentTurn !== playerIndex) return null

  if (state.game === 'tic-tac-toe') {
    const index = Number(move?.index)
    if (!Number.isInteger(index) || index < 0 || index > 8 || state.board[index] !== null) return null
    const board = [...state.board]
    board[index] = playerIndex
    const winner = getTicTacToeWinner(board)
    const isDraw = winner === null && board.every((cell) => cell !== null)
    return {
      ...state,
      board,
      winner,
      status: winner !== null || isDraw ? 'finished' : 'active',
      currentTurn: winner !== null || isDraw ? state.currentTurn : 1 - playerIndex,
      isDraw,
    }
  }

  if (state.game === 'connect-four') {
    const column = Number(move?.column)
    if (!Number.isInteger(column) || column < 0 || column > 6) return null
    let row = -1
    for (let index = state.board.length - 1; index >= 0; index -= 1) {
      if (state.board[index][column] === null) {
        row = index
        break
      }
    }
    if (row < 0) return null
    const board = state.board.map((line) => [...line])
    board[row][column] = playerIndex
    const winner = connectFourWinner(board, row, column, playerIndex) ? playerIndex : null
    const isDraw = winner === null && board.every((line) => line.every((cell) => cell !== null))
    return {
      ...state,
      board,
      winner,
      status: winner !== null || isDraw ? 'finished' : 'active',
      currentTurn: winner !== null || isDraw ? state.currentTurn : 1 - playerIndex,
      isDraw,
    }
  }

  if (state.game === 'dots-and-boxes') {
    const orientation = move?.orientation
    const row = Number(move?.row)
    const column = Number(move?.column)
    const edges = orientation === 'h' ? state.horizontal : orientation === 'v' ? state.vertical : null
    if (!edges || !Number.isInteger(row) || !Number.isInteger(column)
      || row < 0 || row >= edges.length || column < 0 || column >= edges[row].length
      || edges[row][column] !== null) return null

    const next = {
      ...state,
      horizontal: state.horizontal.map((line) => [...line]),
      vertical: state.vertical.map((line) => [...line]),
      boxes: state.boxes.map((line) => [...line]),
      scores: [...state.scores],
    }
    ;(orientation === 'h' ? next.horizontal : next.vertical)[row][column] = playerIndex
    const adjacentBoxes = orientation === 'h'
      ? [[row - 1, column], [row, column]]
      : [[row, column - 1], [row, column]]
    let captured = 0
    adjacentBoxes.forEach(([boxRow, boxColumn]) => {
      if (boxRow >= 0 && boxRow < 3 && boxColumn >= 0 && boxColumn < 3
        && next.boxes[boxRow][boxColumn] === null
        && boxEdgesComplete(next, boxRow, boxColumn)) {
        next.boxes[boxRow][boxColumn] = playerIndex
        captured += 1
      }
    })
    next.scores[playerIndex] += captured
    const finished = next.boxes.every((line) => line.every((box) => box !== null))
    next.status = finished ? 'finished' : 'active'
    next.winner = finished
      ? next.scores[0] === next.scores[1] ? null : next.scores[0] > next.scores[1] ? 0 : 1
      : null
    next.currentTurn = captured || finished ? playerIndex : 1 - playerIndex
    next.isDraw = finished && next.winner === null
    return next
  }
  return null
}
