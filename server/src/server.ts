import express from 'express';
import dotenv from 'dotenv';
import { connectDB } from '../config/db';
import userRoutes from '../routes/user-routes';
import chatRoutes from '../routes/chat-routes';
import messageRoutes from '../routes/message-routes';
import { ErrorHandler, NotFound } from '../middlewares/error-middleware';
import cors from 'cors';
import { Server } from 'socket.io';
import {
  ChatProps,
  JoinRoomPayload,
  MessageProps,
  SocketEmitNames,
  SocketNames,
  UserProps,
  TicTacSockets,
} from '../types';
import { TypeRaceGame } from '../models/type-race-game/player-model';
import { getQuoteData } from '../utils/quotable-api';
import { calculateTime, calculateWPM } from '../utils/game-clock';

dotenv.config();
connectDB();
const app = express();
app.use(express.json());

app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://mern-t-chat.vercel.app',
    ],
  }),
);

// Routes
app.use('/api/user', userRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/message', messageRoutes);
app.use(NotFound);
app.use(ErrorHandler);

// Server Listen
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server is Running on PORT : ${PORT} 🚀`);
});

// Socket IO
const io: Server = new Server(server, {
  pingTimeout: 60000,
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://mern-t-chat.vercel.app',
    ],
  },
});

/**
 * SOCKET CONNECTIONS
 */

let roomIdGlobal;

io.on('connection', (socket) => {
  // Setup Socket
  socket.on<SocketNames>('setup', (userData: UserProps) => {
    socket.join(userData._id);
    socket.emit<SocketEmitNames>('connected');
  });

  // Join Chat Room
  socket.on<SocketNames>('joinChat', (room: ChatProps) => {
    socket.join(room._id);
    console.log('User Joined Room: ' + room._id);
  });

  // Typing event
  socket.on<SocketNames>('typing', (room: ChatProps) => {
    socket.in(room._id).emit<SocketNames>('typing');
  });

  // Stop Typing event
  socket.on<SocketNames>('stopTyping', (room: ChatProps) => {
    socket.in(room._id).emit<SocketNames>('stopTyping');
  });

  // New Message event
  socket.on<SocketNames>('newMessage', (newMessageReceived: MessageProps) => {
    const chat = newMessageReceived.chat;
    if (!chat?.users) return console.log('chat.users not defined');

    chat.users.forEach((user) => {
      if (user._id === newMessageReceived.sender._id) return;
      socket.in(user._id).emit<SocketEmitNames>('messageReceived', newMessageReceived);
    });
  });

  // User joins (TicTacToe)
  socket.on<TicTacSockets>('joinRoom', async (payload: JoinRoomPayload) => {
    try {
      AddUser(socket.id, payload.roomId);

      const user: RoomUser = {
        socketId: socket.id,
        username: payload.username,
        roomId: payload.roomId,
      };

      NewGame(payload.roomId, payload.userId, payload.username);

      socket.join(user.roomId);
      socket.emit<TicTacSockets>('message', 'Welcome to MERN-Tic');

    } catch (error) {
      console.error('Error in joinRoom:', error);
      socket.emit<TicTacSockets>('message', { error: 'Failed to join room' });
    }
  });

  // Move event (TicTacToe)
  socket.on<TicTacSockets>('move', async (payload: JoinRoomPayload) => {
    try {
      const current_room = GetGameDetail(payload.roomId)!;
      let current_username;
      let moveCount;

      if (!current_room.user1.userId || !current_room.user2.userId) {
        io.in(payload.roomId).emit<TicTacSockets>('userLeave', {});
      }

      if (current_room?.user1.userId === payload.userId) {
        current_room.user1.moves.push(payload.move);
        moveCount = current_room.user1.moves.length;
        current_username = current_room.user1.username;
      } else {
        current_room?.user2.moves.push(payload.move);
        moveCount = current_room?.user2.moves.length;
        current_username = current_room?.user2.username;
      }

      io.in(payload.roomId).emit<TicTacSockets>('move', {
        move: payload.move,
        userId: payload.userId,
      });

      if (moveCount >= 3) {
        const { isWin, winCount, pattern } = CheckWin(payload.roomId, payload.userId);
        if (isWin) {
          io.in(payload.roomId).emit<TicTacSockets>('win', {
            userId: payload.userId,
            username: current_username,
            pattern,
          });
          return;
        }

        if (current_room?.user1.moves.length + current_room.user2.moves.length >= 9) {
          io.in(payload.roomId).emit<TicTacSockets>('draw', {
            roomId: payload.roomId,
          });
          return;
        }
      }
    } catch (error) {
      console.error('Error in move:', error);
    }
  });

  // Start Game Clock (Type Race)
  socket.on<TypeRaceSockets>('timer', async ({ playerId, gameId }: TimerPayloadProps) => {
    try {
      let countDown = 5;
      let game = await TypeRaceGame.findById(gameId);
      let player = game?.players.id(playerId);

      if (!player) {
        io.to(gameId).emit<TypeRaceSockets>('timer', {
          countDown: 0,
          msg: 'There is no Player, Try Again',
        });
        io.to(gameId).emit<TypeRaceSockets>('update-game', game);
      }

      if (player?.isPartyLeader) {
        const timerId = setInterval(async () => {
          if (countDown >= 0) {
            io.to(gameId).emit<TypeRaceSockets>('timer', {
              countDown,
              msg: 'Starting Game in...',
            });
            io.to(gameId).emit<TypeRaceSockets>('update-game', game);
            countDown--;
          } else {
            if (game) {
              game.isOpen = false;
              await game.save();
              io.to(gameId).emit<TypeRaceSockets>('update-game', game);
              startGameClock(gameId);
              clearInterval(timerId);
            }
          }
        }, 1000);
      }
    } catch (error) {
      console.error('Error in timer:', error);
    }
  });

  // Disconnect event
  socket.on<TicTacSockets>('disconnect', async () => {
    try {
      const roomId = UserLeft(socket.id)!;
      io.in(roomId).emit<TicTacSockets>('userLeave', { roomId });
      socket.broadcast.emit<VideoSockets>('callEnded');
    } catch (error) {
      console.error('Error in disconnect:', error);
    }
  });
});

/**
 * Start Game Clock Util (Type Race)
 * @param {string} gameId
 */
async function startGameClock(gameId: string) {
  try {
    let game = await TypeRaceGame.findById(gameId);
    if (!game) return;

    game.startTime = new Date().getTime();
    game = await game.save();

    let time = 120; // 2 minutes countdown
    let timerID = setInterval(async () => {
      if (time >= 0) {
        const formatTime = calculateTime(time);
        io.to(gameId).emit<TypeRaceSockets>('timer', {
          countDown: formatTime,
          msg: 'Time Remaining',
        });
        time--;
      } else {
        game.isOver = true;
        await game.save();
        io.to(gameId).emit<TypeRaceSockets>('update-game', game);
        clearInterval(timerID);
      }
    }, 1000);
  } catch (error) {
    console.error('Error starting game clock:', error);
  }
}
