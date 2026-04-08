module.exports = (io) => {
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('join:conversation', (convId) => { socket.join('conv:'+convId); });
    socket.on('leave:conversation', (convId) => { socket.leave('conv:'+convId); });
    socket.on('typing', (data) => { socket.to('conv:'+data.conversationId).emit('typing', data); });
    socket.on('disconnect', () => { console.log('Client disconnected:', socket.id); });
  });
};
