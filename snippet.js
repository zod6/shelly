var MIN_PRICE = 30;      // values under this are always ON (MWh)
// MIN and MAX values depend on temperature. Currently current temperature applies for today and tomorrow.
// MAX values are used when Temp = 0°
// MIN values are used when Temp = -20°C
// change function calc_minmax if needed
var MIN_HOURS_OFF = 5;  // how many hours off in 24h period per -20°C
var MAX_HOURS_OFF = 10;  // how many hours off in 24h period per 0°C
var MIN_OFF_SEQ = 2;    // how many hours in a row it can be off per -20°C
var MAX_OFF_SEQ = 5;    // how many hours in a row it can be off per 0°C

// Turn relay off on high hours. To invert, set to 'true'
var Invert_relay = false;
var Today = new Date();
var Tomorrow = new Date(Date.now() + 1*86400000); // today+24h

var Temp_url = "https://www.ilmateenistus.ee/ilma_andmed/ticker/vaatlused-html.php?jaam=14"; // Tallinn-Harku
// TODO: use forecast for tomorrow. https://www.ilmateenistus.ee/ilma_andmed/xml/forecast.php
var Temp = -10; // default if parsing failed

var HOURS_OFF = Math.round((MAX_HOURS_OFF - MIN_HOURS_OFF) / 2);
var OFF_SEQ   = Math.round((MAX_OFF_SEQ - MIN_OFF_SEQ) / 2);
function calc_minmax() {
	var upper_temp = 0;
	var lower_temp = -20;
	if(Temp <= lower_temp) {
		HOURS_OFF = MIN_HOURS_OFF;
		OFF_SEQ = MIN_OFF_SEQ;
	} else if(Temp >= upper_temp) {
		HOURS_OFF = MAX_HOURS_OFF;
		OFF_SEQ = MAX_OFF_SEQ;
	} else {
		HOURS_OFF = Math.round((Temp - upper_temp) / (lower_temp - upper_temp) * (MAX_HOURS_OFF - MIN_HOURS_OFF) + MIN_HOURS_OFF);
		OFF_SEQ = Math.round((Temp - upper_temp) / (lower_temp - upper_temp) * (MAX_OFF_SEQ - MIN_OFF_SEQ) + MIN_OFF_SEQ);
	}
	console.log("Outside temp: " + Temp);
	console.log("HOURS_OFF: " + HOURS_OFF);
	console.log("OFF_SEQ: " + OFF_SEQ);
}

function parse_temp(result) {
	if (result === null) print("temperature fetch failed or skipped");
	else {
		let i = result.body.slice(result.body.indexOf("Temperatuur: ")+13, result.body.indexOf(" &deg;C"));
		if (!isNaN(i)) Temp = i;
	}
	calc_minmax();
	let yesterday = new Date(Date.now() - 86400000); // today-24h
	var url = "https://dashboard.elering.ee/api/nps/price?start=" + yesterday.getFullYear() + "-" + ("0"+(yesterday.getMonth()+1)).slice(-2) + "-" + ("0"+yesterday.getDate()).slice(-2) + "T20%3A59%3A59.999Z&end=" + Tomorrow.getFullYear() + "-" + ("0"+(Tomorrow.getMonth()+1)).slice(-2) + "-" + ("0"+Tomorrow.getDate()).slice(-2) + "T23%3A59%3A59.999Z";
	console.log(url);
	Shelly.call("http.get", { url: url, timeout:10, ssl_ca:"*"}, parse_nordpool);
}

function parse_nordpool(result) {
	if (result === null) {
		print("fetch failed"); // TODO: insert default
		return;
	}
	//console.log(JSON.parse(result.body).data.ee);
	// hack. Shelly JSON doesn't like too long strings.
	let i, prices;
	let json_obj = JSON.parse(result.body.slice(result.body.indexOf("ee")+4, result.body.indexOf("fi")-2));


	// create two-dimensional array [hour, price]
	for (var date of [Today, Tomorrow]) {
		i = 0;
		prices = [];
		for (var x of json_obj) {
			if (new Date(x.timestamp*1000).getDate() == date.getDate()){
				if(x.price > MIN_PRICE) prices.push({hour: new Date(x.timestamp*1000).getHours(), price: x.price});
				i++;
			}
		}
		console.log("init: ", prices);
		if (i != 24) console.log(date.toString() + " Length = " + i + " !!");
		else find_cheapest(prices, date.getDay());
	}
	console.log("Schedule cnt:" + schedule_cnt);
	//console.log(schedule_arr);
	Shelly.call("Schedule.DeleteAll", {}, schedule_create_run_script);
}

function find_cheapest(prices, wday) {
	sort(prices, function(a, b){return b.price - a.price;});
	prices.splice(HOURS_OFF + HOURS_OFF/OFF_SEQ); // keep first x most expensive + for removal (for leaving gaps)

	// find ranges where OFF duration is too long
	sort(prices, 0); // sort by hour
	let seq = 0;
	let rows_to_remove = [];
	for (let i=1; i < prices.length; i++) {
		if (prices[i-1].hour == prices[i].hour-1) seq++;
		else {
			if(seq >= OFF_SEQ) {
				//console.log("start: " + (i-seq-1) + " hr: " + prices[i-seq-1].hour);
				let x = findlowest(prices.slice(i-seq-1, i));
				for (let j = 0; j < x.length; j++) rows_to_remove.push(x[j] + i - seq-1);
				//console.log("rowstoremove: ", rows_to_remove);
			}
			seq = 0;
		}
	}
	if(seq >= OFF_SEQ) {
		let start = prices.length - seq-1;
		//console.log("start: " + (prices.length - seq-1) + " hr: " + prices[prices.length - seq-1].hour);
		let x = findlowest(prices.slice(prices.length - seq-1, prices.length));
		for (let j = 0; j < x.length; j++) rows_to_remove.push(x[j] + prices.length - seq-1);
		//console.log("rowstoremove: ", rows_to_remove);
	}
	// remove entries to leave big enough gaps
	for (let i = rows_to_remove.length-1; i >= 0; i--) prices.splice(rows_to_remove[i], 1);

	// still too many hours. remove most expensive one
	sort(prices, function(a, b){return a.price - b.price;}); // sort cheapest first
	while(prices.length > HOURS_OFF) prices = prices.slice(1);  // remove first

	sort(prices, 0);
	console.log("final: ", prices);
	console.log("- - - -");
	let current = !Invert_relay; // default true
	for (let i = 0; i < prices.length; i++) {
		if (Today.getHours() == prices[i].hour) current = Invert_relay;
		if (i == 0 || prices[i-1].hour != prices[i].hour-1) {
			if (i != 0) {
				print("0 0 " + (prices[i-1].hour+1) + " * * " + wday + (!Invert_relay ? "| on" : "| off"));
				schedule_add("0 0 " + (prices[i-1].hour+1) + " * * " + wday, !Invert_relay);
			}
			print("0 0 " + prices[i].hour + " * * " + wday + (Invert_relay ? "| on" : "| off"));
			schedule_add("0 0 " + prices[i].hour + " * * " + wday, Invert_relay);
		}
	}
	print("40 59 " + prices[prices.length-1].hour + " * * " + wday + (!Invert_relay ? "| on" : "| off"));
	schedule_add("40 59 " + prices[prices.length-1].hour + " * * " + wday, !Invert_relay); // hh:59:40
	if (Today.getDay() == wday) {
		print("set relay " + (current == false ? "OFF" : "ON"));
		Shelly.call("switch.set",{ id: 0, on: current});
	}
}

var schedule_cnt = 1; // actually 0...
var schedule_arr = [];
function schedule_create_run_script() {
	Shelly.call("Schedule.Create", {
		"enable": true, "timespec": "0 1 17 * * *",
		"calls": [{
			"method": "Script.start",
			"params": { "id": Shelly.getCurrentScriptId() }
		}] }, schedule_create); // every day at 17:01
}
function schedule_create(result, error_code, error_message) {
	schedule_cnt--;
	//if(result != null) console.log(result);
	if(error_code) console.log(error_message);
	//else console.log(result);
	if(!schedule_cnt) return;
	Shelly.call("Schedule.Create", {
		"enable": true, "timespec": schedule_arr[schedule_cnt-1][0],
		"calls": [{
			"method": "Switch.Set",
			"params": { "id": 0, "on": schedule_arr[schedule_cnt-1][1] }
		}]
	}, schedule_create);
}

function schedule_add(timespec, turn_on){
	schedule_cnt++;
	schedule_arr.push([timespec, turn_on]);
}

// if device can't be off too long, find out cheapest combination
// and return array of indexes that need to be kept
function findlowest(arr) {
	const n = arr.length;

	//console.log("input: ", arr)
	//const min = new Array(n).fill(0);
	const min = [];
	for (var i = 0; i < n; i++) min[i] = 0;

	//const elements = new Array(n).fill(null).map(() => []);
	const elements = [];
	for (var i = 0; i < n; i++) elements[i] = [];

	// Base cases
	for (let i = 0; i <= OFF_SEQ; i++) {
		min[i] = arr[i].price;
		elements[i] = [i];
	}

	// Iterate through the array to fill the min and elements arrays
	let x, x_pos;
	for (let i = OFF_SEQ + 1; i <= n; i++) {
		x_pos = i - OFF_SEQ - 1;
		x = min[x_pos];
		for (let j = i - OFF_SEQ; j < i; j++) {
			if (min[j] < x) {
				x = min[j];
				x_pos = j;
			}
		}
		if (i < n) {
			min[i] = min[x_pos] + arr[i].price;
			elements[i] = [];
			for (var k = 0; k < elements[x_pos].length; k++) elements[i].push(elements[x_pos][k]);
			elements[i].push(i);
		} else {
			//console.log("Lowest Sum:", min[x_pos]);
			//console.log("Chosen Elements:", elements[x_pos]);
			return elements[x_pos];
		}
		//console.log(elements);
	}
}

function sort(array, fn) {
	let i, j, minmax, minmax_indx;
	if (fn == 0) fn = function(a, b) { return a.hour - b.hour; }

	for (i = 0; i < array.length; i++) {
		minmax = 0;
		for (j = i; j < array.length; j++) {
			if (!minmax || fn(array[j], minmax)>0){
				minmax = array[j];
				minmax_indx = j;
			}
		}
		array.splice(minmax_indx, 1); // delete old
		array.splice(0, 0, minmax); // insert to beginning
	}
}

Timer.set(180* 1000, false, function () { Shelly.call("Script.stop", { "id": Shelly.getCurrentScriptId()}) }); // stop after 3min
let secrand = JSON.stringify(Math.floor(Math.random() * 60*1));
print("Starting in " + secrand/60 + " minutes");
// Delay excecuting
Timer.set(secrand * 1000, false, function () {
	if (MAX_HOURS_OFF == MIN_HOURS_OFF && MAX_OFF_SEQ == MIN_OFF_SEQ) parse_temp(null); // skip temp query
	else Shelly.call("http.get", { url: Temp_url, timeout:10, ssl_ca:"*"}, parse_temp);
});

