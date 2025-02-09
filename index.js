const express = require('express');
const bodyParser = require('body-parser');
var cors = require('cors');
var jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
require('dotenv').config();  // Load environment variables from .env file

const app = express();
const port = process.env.PORT || 3000;
const uri = `${process.env.MONGODB_URI}`;
const jwtSecret = `${process.env.JWT_SECRET}`;

app.use(cors({
  origin: ['https://postman.com'],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  credentials: true,
}));
app.use(bodyParser.json());

const helmet = require('helmet');
app.use(helmet());

// Connect to MongoDB using mongoose
mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  }).then(() => {
    console.log('Connected to MongoDB');
    
    // Start the server
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  }).catch(err => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);  // Exit process on failure to connect to MongoDB
  });

// Define Schemas and Models
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  historyPasswords: { type: [String], default: [] },
  failedLoginAttempts: { type: Number, default: 0 },
  lastFailedLogin: { type: Date, default: null },  // Store last failed attempt was made
});

const questionSchema = new mongoose.Schema({
  question: { type: String, required: true },
  options: { type: [String], required: true },
  correctAnswer: { type: String, required: true },
});

const scoreSchema = new mongoose.Schema({
  username: { type: String, required: true },
  score: { type: Number, required: true },
  date: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const Question = mongoose.model('Question', questionSchema);
const Score = mongoose.model('Score', scoreSchema);

// Middleware for authentication
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, jwtSecret, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Password policy
const validatePassword = (password, username, previousPasswords) => {
  let errors = [];

  if (password.length < 8 || password.length > 12) {
    errors.push('Password must be 8-12 characters long.');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number.');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter.');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter.');
  }
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character.');
  }
  if (password.toLowerCase().includes(username.toLowerCase())) {
    errors.push('Password must not contain the username.');
  }
  if (previousPasswords.some((hash) => bcrypt.compareSync(password, hash))) {
    errors.push('Password must not have been used before.');
  }

  // Alternate errors display
  let i = 0;
  const showErrorsAlternately = () => {
    if (i < errors.length) {
      console.log(errors[i]); 
      i++;
      setTimeout(showErrorsAlternately, 1000);
    }
  };
  
  showErrorsAlternately(); 

  return errors;
};

// User routes
app.post('/api/users/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).send({ error: 'Username and password are required' });
  }

  try {
    // Check if user already exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).send({ error: 'User already exists' });
    }

    const passwordErrors = validatePassword(password, username, []);
    if (passwordErrors.length > 0) {
      return res.status(400).send({ error: passwordErrors.join(' ') });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();

    res.status(201).send('User registered successfully');
  } catch (error) {
    res.status(400).send('Error registering user');
  }
});

 const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // Limit each IP to 5 requests per windowMs
  message: 'Too many login attempts from this IP, please try again later',
});

app.post('/api/users/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).send({ error: 'Username and password are required' });
  }

  try {
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).send({ error: 'Invalid credentials' });
    }
    
    // Check if the account is locked due to too many failed attempts
    if (user.failedLoginAttempts >= 3) {
      const timeSinceLastFailed = Date.now() - new Date(user.lastFailedLogin).getTime();
      const lockoutTime = 1 * 60 * 1000; // 1 minutes

      if (timeSinceLastFailed < lockoutTime) {
        return res.status(403).send({
          error: 'Too many failed login attempts. Please try again later in 60 seconds.',
        });
      } else {
        // Reset failed attempts after the lockout period
        user.failedLoginAttempts = 0;
        user.lastFailedLogin = null;
      }
    }

    // Validate the password
    const isPasswordCorrect = await bcrypt.compare(password, user.password);

    if (!isPasswordCorrect) {
      // Increment failed attempts counter
      user.failedLoginAttempts += 1;
      user.lastFailedLogin = Date.now();
      await user.save();

      return res.status(401).send({ error: 'Invalid credentials' });
    }

    // Reset failed attempts on successful login
    user.failedLoginAttempts = 0;
    user.lastFailedLogin = null;
    await user.save();

    const token = jwt.sign({ username: user.username }, jwtSecret, { expiresIn: '1h' });
    res.json({ token });
  } catch (error) {
    res.status(500).send({ error: 'An error occurred during login' });
  }
});

app.get('/api/users/:username', authenticateToken, async (req, res) => {
  const username = req.params.username;

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).send({ error: 'User not found' });
    }
    res.send(user);
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while fetching the user' });
  }
});

// Update user password
app.patch('/api/users/:username', authenticateToken, async (req, res) => {
  const { username } = req.params;
  const { password } = req.body;

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).send({ error: 'User not found.' });
    }

    if (password) {
      const passwordErrors = validatePassword(password, username, user.historyPasswords);
      if (passwordErrors.length > 0) {
        return res.status(400).send({ error: passwordErrors.join(' ') });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      user.historyPasswords.push(user.password);
      user.password = hashedPassword;
      await user.save();
    }
    res.send({ message: 'User updated successfully' });
  } catch (error) {
    res.status(400).send({ error: 'Error.' });
  }
});

app.delete('/api/users/:username', authenticateToken, async (req, res) => {
  const username = req.params.username;

  try {
    const result = await User.deleteOne({ username });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: 'User not found' });
    }
    res.send({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while deleting the user' });
  }
});

const checkAdminRole = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).send({ error: 'Forbidden' });
  }
  next();
};

// Question routes
app.post('/api/questions', authenticateToken, checkAdminRole, async (req, res) => {
  const { question, options, correctAnswer } = req.body;

  try {
    const newQuestion = new Question({ question, options, correctAnswer });
    const result = await newQuestion.save();
    res.status(201).send({ questionId: result._id });
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while creating the question' });
  }
});

app.get('/api/questions', authenticateToken, async (req, res) => {
  try {
    const questions = await Question.find({}, { correctAnswer: 0, _id: 0 }).lean();
    res.send(questions);
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while fetching the questions' });
  }
});

app.patch('/api/questions/:id', authenticateToken, checkAdminRole, async (req, res) => {
  const questionId = req.params.id;
  const { question, options, correctAnswer } = req.body;

  try {
    const result = await Question.updateOne(
      { _id: questionId },
      { $set: { question, options, correctAnswer } }
    );

    if (result.nModified === 0) {
      return res.status(404).send({ error: 'Question not found' });
    }

    res.send({ message: 'Question updated successfully' });
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while updating the question' });
  }
});

app.delete('/api/questions/:id', authenticateToken, checkAdminRole, async (req, res) => {
  const questionId = req.params.id;

  try {
    const result = await Question.deleteOne({ _id: questionId });

    if (result.deletedCount === 0) {
      return res.status(404).send({ error: 'Question not found' });
    }

    res.send({ message: 'Question deleted successfully' });
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while deleting the question' });
  }
});

// Score routes
app.post('/api/scores', authenticateToken, async (req, res) => {
  const { username, score } = req.body;

  try {
    const newScore = new Score({ username, score });
    const result = await newScore.save();
    res.status(201).send({ scoreId: result._id });
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while saving the score' });
  }
});

app.get('/api/score', authenticateToken, async (req, res) => {
  try {
    const scores = await Score.find({}, { _id: 0 }).lean();
    res.send(scores);
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while fetching the scores' });
  }
});

app.patch('/api/scores/:username', authenticateToken, async (req, res) => {
  const username = req.params.username;
  const { score } = req.body;

  try {
    const result = await Score.updateOne({ username }, { $set: { score } });
    if (result.nModified === 0) {
      return res.status(404).send({ error: 'Score not found' });
    }
    res.send({ message: 'Score updated successfully' });
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while updating the score' });
  }
});

app.delete('/api/scores/:username', authenticateToken, checkAdminRole, async (req, res) => {
  const username = req.params.username;

  try {
    const result = await Score.deleteOne({ username });

    if (result.deletedCount === 0) {
      return res.status(404).send({ error: 'Score not found' });
    }

    res.send({ message: 'Score deleted successfully' });
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while deleting the score' });
  }
});

// Submit answers route
app.post('/api/submit', authenticateToken, async (req, res) => {
  const { username, answers } = req.body;

  try {
    // Fetch all questions
    const questions = await Question.find({}).lean();

    if (questions.length !== answers.length) {
      return res.status(400).send('Number of answers does not match number of questions');
    }

    // Calculate score
    let score = 0;
    for (let i = 0; i < questions.length; i++) {
      if (questions[i].correctAnswer === answers[i]) {
        score++;
      }
    }

    // Save score to the database
    const newScore = new Score({ username, score });
    await newScore.save();

    res.status(201).send({ message: 'Score submitted successfully', score });
  } catch (error) {
    res.status(500).send({ error: 'An error occurred while submitting the answers' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('An error occurred:', err);
  res.status(500).send({ error: 'Internal Server Error' });
});