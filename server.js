const express = require("express");
const cheerio = require("cheerio");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const xss = require("xss");
require("dotenv").config();

const app = express();

// Security and configuration improvements
app.use(cors());
app.use(express.static("public")); // Serve frontend files
app.use(express.json());
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self';"
  )
})

// Environment variable validation
const requiredEnvVars = ['SCRAPE_API_FIRST', 'SCRAPE_API_LAST', 'TEMPERATURE_CLASS', 'MIN_MAX_TEMPERATURE_CLASS', 'HUMIDITY_PRESSURE_CLASS', 'CONDITION_CLASS', 'DATE_CLASS'];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Error: Missing environment variable ${varName}`);
    process.exit(1);
  }
});

// Rate limiting middleware (example)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    status: 429,
    error: "Too many requests, please try again later."
  },
  headers: true,  // Send rate limit headers
  keyGenerator: (req) => req.ip, // Ensure consistent IP extraction
  handler: (req, res) => {
    res.set("Retry-After", Math.ceil(limiter.windowMs / 1000));  // Add Retry-After header
    res.status(429).json({
      error: "Too many requests. Please try again later.",
      retryAfter: Math.ceil(limiter.windowMs / 1000) + " seconds"
    });
  }
});
app.use(limiter);

// Sanitize input to prevent XSS
const sanitizeInput = (str) => xss(str.trim());

// Parsing function to extract humidity and pressure
const parseHumidityPressure = (rawText) => {
  // Split the raw text by periods (.)
  if (!rawText) {
    return { humidity: "N/A", pressure: "N/A" }; // Return N/A if rawText is not provided
  }

  // Split the raw text by periods (.)
  const parts = rawText.split('.');

  // Ensure that we have enough parts in the array to access
  if (parts.length < 2) {
    return { humidity: "N/A", pressure: "N/A" }; // Return N/A if the split parts are not enough
  }

  // Extract humidity (last part) and pressure (second last part)
  const humidity = parts[parts.length - 1] || "N/A";  // Last part is humidity
  const rawPressure = parts[parts.length - 2] || "N/A";

  // Function to parse pressure correctly
  const parsePressure = (rawPressure) => {
    // Convert the raw pressure value to float and divide by 100 to adjust scale if necessary
    const pressure = parseFloat(rawPressure);

    // If pressure is greater than 10000 (indicating it might be in Pascals), convert to hPa (divide by 100)
    if (pressure > 10000) {
      return (pressure / 100).toFixed(2); // Scale down by dividing by 100 and return with 2 decimal places
    }

    // If pressure is greater than 1000, divide by 10 to bring it to a standard atmospheric range
    if (pressure > 1000) {
      return (pressure / 10).toFixed(2); // Divide by 10 and return with 2 decimal places
    }

    // Otherwise, just return the pressure as is, rounded to the nearest integer
    return Math.round(pressure);
  };

  // Parsing the pressure correctly
  const pressure = parsePressure(rawPressure);

  return { humidity, pressure };
};

// Improved Error Handling Middleware
const handleError = (res, statusCode, message, code) => {
  res.status(statusCode).json({
    error: message,
    code: code || statusCode
  });
};

// Enhanced API endpoint
app.get("/api/weather/:city", async (req, res) => {
  try {
    const city = sanitizeInput(req.params.city);

    // Enhanced input validation
    if (!city || !/^[a-zA-Z\s-]{2,50}$/.test(city)) {
      return handleError(res, 400, "Invalid city name. Use letters, spaces, and hyphens (2-50 chars).", "INVALID_CITY");
    }

    try {
      const response = await axios.get(
        `${process.env.SCRAPE_API_FIRST}${encodeURIComponent(city)}${process.env.SCRAPE_API_LAST}`,
        { timeout: 5000 } // Add timeout to prevent hanging requests
      );

      const $ = cheerio.load(response.data);

      // Function to safely get text from a given selector with error checking
      const getElementText = (selector) => {
        const element = $(selector);
        if (!element.length) {
          throw new Error(`Required element ${selector} not found`);
        }
        return element.text()?.trim() || null;
      };

      try {
        const temperature = getElementText(process.env.TEMPERATURE_CLASS);
        const minMaxTemperature = getElementText(process.env.MIN_MAX_TEMPERATURE_CLASS);
        const humidityPressureText = getElementText(process.env.HUMIDITY_PRESSURE_CLASS);
        const condition = getElementText(process.env.CONDITION_CLASS);
        const date = getElementText(process.env.DATE_CLASS);

        if (!temperature || !condition) {
          return handleError(res, 404, "Weather data not found for the specified city.", "DATA_NOT_FOUND");
        }

        // Parse weather data
        const minTemperature = minMaxTemperature?.match(/(\d+°)/)?.[0] || "N/A";
        const maxTemperature = minMaxTemperature?.match(/(\d+°)/)?.[1] || "N/A";
        const { humidity, pressure } = parseHumidityPressure(humidityPressureText);

        const weatherData = {
          date,
          temperature,
          condition,
          minTemperature,
          maxTemperature,
          humidity,
          pressure
        };

        res.json(weatherData);

      } catch (parsingError) {
        console.error("Data parsing error:", parsingError);
        return res.status(503).json({
          error: "Unable to parse weather data. The weather service might be temporarily unavailable."
        });
      }

    } catch (scrapingError) {
      console.error("Scraping error:", scrapingError);

      if (scrapingError.code === 'ECONNABORTED') {
        return handleError(res, 504, "Request timeout. Weather service took too long.", "TIMEOUT");
      }

      if (scrapingError.response?.status === 404) {
        return handleError(res, 404, "City not found. Please check the spelling.", "CITY_NOT_FOUND");
      }

      return handleError(res, 503, "Weather service temporarily unavailable.", "SERVICE_UNAVAILABLE");
    }
  } catch (error) {
    console.error("Server error:", error);
    handleError(res, 500, "Unexpected server error. Please try again later.", "SERVER_ERROR");
  }
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { app, server };