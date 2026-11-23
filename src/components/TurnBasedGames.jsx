import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { applyTurnMove, createTurnGameState } from '../data/gameRules'
import { useRestaurant } from '../context/RestaurantContext'

const gameNames = {
  'tic-tac-toe': 'Tic-Tac-Toe',
  'connect-four': 'Connect Four',
  'dots-and-boxes': 'Dots & Boxes',
}

export function GameBoard({ game, state, onMove, disabled = false }) {
  if (!state) return null
  if (game === 'tic-tac-toe') {
    return <div className="table-game-board tic-board" role="grid" aria-label="Tic-Tac-Toe board">
      {state.board.map((cell, index) => <button
        key={index}
        type="button"
        role="gridcell"
        disabled={disabled || state.status !== 'active' || cell !== null}
        aria-label={cell === null ? `Empty square ${index + 1}` : `Square ${index + 1}, Player ${cell + 1}`}
        onClick={() => onMove({ index })}
      >{cell === null ? '' : cell === 0 ? '×' : '○'}</button>)}
    </div>
  }
  if (game === 'connect-four') {
    return <div className="table-game-board connect-board" role="grid" aria-label="Connect Four board">
      {state.board.flatMap((row, rowIndex) => row.map((cell, columnIndex) => <button
        key={`${rowIndex}-${columnIndex}`}
        type="button"
        className={cell === null ? '' : `disc-${cell}`}
        disabled={disabled || state.status !== 'active' || !state.board.some((line) => line[columnIndex] === null)}
        aria-label={`Row ${rowIndex + 1}, column ${columnIndex + 1}${cell === null ? ', empty' : `, Player ${cell + 1}`}`}
        onClick={() => onMove({ column: columnIndex })}
      />))}
    </div>
  }
  if (game === 'dots-and-boxes') {
    return <div className="table-game-board dots-board" role="grid" aria-label="Dots and Boxes board">
      {Array.from({ length: 7 }, (_, boardRow) => Array.from({ length: 7 }, (_, boardColumn) => {
        const row = Math.floor(boardRow / 2)
        const column = Math.floor(boardColumn / 2)
        if (boardRow % 2 === 0 && boardColumn % 2 === 0) {
          return <span className="dots-cell" key={`${boardRow}-${boardColumn}`}><i className="dots-dot" /></span>
        }
        if (boardRow % 2 === 0) {
          const owner = state.horizontal[row][column]
          return <button
            type="button"
            key={`${boardRow}-${boardColumn}`}
            className={`dots-edge edge-h${owner === null ? '' : ` owner-${owner}`}`}
            aria-label={`Horizontal line ${row + 1}, ${column + 1}`}
            disabled={disabled || state.status !== 'active' || owner !== null}
            onClick={() => onMove({ orientation: 'h', row, column })}
          />
        }
        if (boardColumn % 2 === 0) {
          const owner = state.vertical[row][column]
          return <button
            type="button"
            key={`${boardRow}-${boardColumn}`}
            className={`dots-edge edge-v${owner === null ? '' : ` owner-${owner}`}`}
            aria-label={`Vertical line ${row + 1}, ${column + 1}`}
            disabled={disabled || state.status !== 'active' || owner !== null}
            onClick={() => onMove({ orientation: 'v', row, column })}
          />
        }
        const owner = state.boxes[row][column]
        return <span className={`dots-cell dots-box${owner === null ? '' : ` owner-${owner}`}`} key={`${boardRow}-${boardColumn}`} aria-label={owner === null ? 'Unclaimed box' : `Player ${owner + 1} box`}>
          {owner === null ? '' : owner + 1}
        </span>
      }))}
    </div>
  }
  return null
}

export function PassPlayGame({ game, tableId, sessionId, onBack }) {
  const { awardCoupon } = useRestaurant()
  const [state, setState] = useState(() => createTurnGameState(game))
  const rewardSent = useRef(false)
  const currentPlayer = state.currentTurn
  const isFinished = state.status === 'finished'
  const result = state.winner === null
    ? 'A fine match — it’s a draw.'
    : `Player ${state.winner + 1} wins!`

  useEffect(() => {
    if (state.status === 'active') rewardSent.current = false
    if (state.status === 'finished' && state.winner !== null && !rewardSent.current) {
      rewardSent.current = true
      awardCoupon(tableId, sessionId)
    }
  }, [state, awardCoupon, tableId, sessionId])

  const move = (nextMove) => {
    const next = applyTurnMove(state, currentPlayer, nextMove)
    if (next) setState(next)
  }

  return <div className="arcade-view">
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Back to game modes</button>
    <div className="arcade-heading"><div><span className="eyebrow">PASS & PLAY · SAME DEVICE</span><h1>{gameNames[game]}</h1></div><span className="arcade-opponent">PLAYER {currentPlayer + 1}’S TURN</span></div>
    {game === 'dots-and-boxes' && <div className="multiplayer-scores"><span>Player 1 · {state.scores[0]}</span><span>Player 2 · {state.scores[1]}</span></div>}
    {isFinished
      ? <div className="multiplayer-turn multiplayer-result" role="status">{result}</div>
      : <div className="multiplayer-turn">Pass the phone to Player {currentPlayer + 1}</div>}
    <GameBoard game={game} state={state} onMove={move} disabled={isFinished} />
    {isFinished && <button className="primary-button" onClick={() => setState(createTurnGameState(game))}><RotateCcw size={15} /> Play again</button>}
  </div>
}
