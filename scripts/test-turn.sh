#!/bin/bash

# TURN Server Test Script
# Usage: ./test-turn.sh <TURN_SERVER_IP> <USERNAME> <PASSWORD>

if [ $# -ne 3 ]; then
    echo "Usage: $0 <TURN_SERVER_IP> <USERNAME> <PASSWORD>"
    echo "Example: $0 123.456.789.0 myuser mypassword"
    exit 1
fi

TURN_SERVER=$1
USERNAME=$2
PASSWORD=$3

echo "Testing TURN Server: $TURN_SERVER"
echo "Username: $USERNAME"
echo ""

# Test UDP
echo "Testing UDP port 3478..."
nc -vzu $TURN_SERVER 3478

# Test TCP
echo "Testing TCP port 3478..."
nc -vz $TURN_SERVER 3478

# Test TLS
echo "Testing TLS port 5349..."
nc -vz $TURN_SERVER 5349

echo ""
echo "If all tests pass, add to your .env:"
echo "TURN_SERVER_URL=turn:${TURN_SERVER}:3478"
echo "TURN_USERNAME=${USERNAME}"
echo "TURN_CREDENTIAL=${PASSWORD}"
