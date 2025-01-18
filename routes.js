const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Admin = require('./models/admin');
const Question = require('./models/question');

const router = express.Router();

// Admin login (authentication)
router.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });

    if (!admin || !(await admin.matchPassword(password))) {
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: admin._id, username: admin.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
});

// Add new question (admin only)
router.post('/admin/question', async (req, res) => {
    const { question, options, answer } = req.body;

    const newQuestion = new Question({ question, options, answer });
    await newQuestion.save();
    res.json({ message: 'Question added successfully', question: newQuestion });
});

// Get questions for quiz (user side)
router.get('/quiz', async (req, res) => {
    const questions = await Question.find();
    res.json(questions);
});

// Check the answer to a question (user side)
router.post('/quiz/answer', (req, res) => {
    const { questionId, selectedAnswer } = req.body;

    Question.findById(questionId, (err, question) => {
        if (err || !question) {
            return res.status(400).json({ message: 'Question not found' });
        }
        
        if (selectedAnswer === question.answer) {
            res.json({ message: 'Correct!' });
        } else {
            res.json({ message: 'Incorrect, try again!' });
        }
    });
});

module.exports = router;