/*
 * Copyright 2012 Rodrigo Reyes
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var fullproof = fullproof || {};

/**
 * A TextInjector associates an index and an analyzer to provide an
 * object able to inject texts.
 * 
 * @constructor
 * @param index the index to use when injecting
 * @param analyzer the analyzer to use to parse and normalize the text
 */
fullproof.TextInjector = function(index, analyzer) {
	if (!(this instanceof fullproof.TextInjector)) {
		return new fullproof.TextInjector(index,analyzer);
	}
	this.index = index;
	this.analyzer = analyzer;
};

/**
 * Inject a text and associates each of the word it composed with the provided value.
 * @param text some text to inject in the index
 * @param value the value associated to each word from the text
 * @param callback a function to call when the injection is complete
 */
fullproof.TextInjector.prototype.inject = function(text,value,callback) {
	var self = this;
	this.analyzer.getArray(text, function(array_of_words) {
		var synchro = fullproof.make_synchro_point(callback, array_of_words.length);
		for (var i=0; i<array_of_words.length; ++i) {
			var val = array_of_words[i];
			if (val instanceof fullproof.ScoredEntry) {
				val.value = val.value===undefined?value:val.value;
				self.index.inject(val.key, val, synchro); // the line number is the value stored
			} else {
				self.index.inject(array_of_words[i], value, synchro); // the line number is the value stored
			}
		}
	});
};

/**
 * Bulk-inject an array of  text and an array of values. The text injected is associated to the value
 * of the same index from the valueArray array. An optional progress function is called at regular interval
 * to provide a way for the caller to give user feedback on the process.
 * 
 * @param texArray an array of text
 * @param valueArray an array of values. The length of valueArray must equal the length of textArray.
 * @param callback a function to call when the injection is complete
 * @param progressCallback a function called with progress indication. A numeric argument is provided to 
 * the function, which ranges from 0 to 1 (0 meaning not done, 1 meaning complete). Note that due to the
 * floating nature of numeric values in javascript, you should not rely on receiving a 1, rather use
 * the callback function parameter, which will be always called on completion of the injection.
 */
fullproof.TextInjector.prototype.injectBulk = function(textArray, valueArray, callback, progressCallback) {
	var words = [];
	var values = [];
	var self = this;
	for (var i=0, max=Math.min(textArray.length, valueArray.length); i<max; ++i) {
		(function(text,value) {
			self.analyzer.getArray(text, function(array_of_words) {
				for (var w=0; w<array_of_words.length; ++w) {
					var val = array_of_words[w];
					if (val instanceof fullproof.ScoredEntry) {
						val.value = val.value===undefined?value:val.value;
						words.push(val.key);
						values.push(val);
					} else {
						words.push(val);
						values.push(value);
					}
				}
			});
		})(textArray[i], valueArray[i]);
	}
	this.index.injectBulk(words,values, callback, progressCallback);
}; 

/**
 * Represent all the data associated to an index, from the point of view of a search engine.
 */
fullproof.IndexUnit = function(name,capabilities,analyzer,index) {
	/**
	 * The name of the index
	 */
	this.name=name;
	/**
	 * The fullproof.Capabilities object originally associated to the index
	 */
	this.capabilities = capabilities;
	/**
	 * The parser used to inject text in the index
	 */
	this.analyzer=analyzer;
	/**
	 * The index itself
	 */
	this.index=index;
}

fullproof.AbstractEngine = fullproof.AbstractEngine || (function() {});

fullproof.AbstractEngine.prototype.checkCapabilities = function(capabilities, analyzer) {
	return true;
}

fullproof.AbstractEngine.prototype.addIndexes =  function(indexes, callback) {
	var starter = false;
	var engine = this;
	while (indexes.length > 0) {
		var data = indexes.pop();
		starter = (function(next, data) {
			return function() {
				engine.addIndex(data.name, data.analyzer, data.capabilities, data.initializer, next!==false?next:callback);
			};
		})(starter, data);
	}
	if (starter !== false) {
		starter();
	}
}

fullproof.AbstractEngine.prototype.addIndex = function(name, analyzer, capabilities, initializer, completionCallback) {
	var self = this;
	var indexData = new fullproof.IndexUnit(name,capabilities,analyzer); 

	if (!this.checkCapabilities(capabilities, analyzer)) {
		return completionCallback(false);
	}

	var indexRequest = new fullproof.IndexRequest(name, capabilities, function(index, callback) {
		var injector = new fullproof.TextInjector(index, indexData.analyzer);
		initializer(injector, callback);
	});
	
	if (this.storeManager.addIndex(indexRequest)) {
		if (this.indexes === undefined) {
			this.indexes = [];
		}
		this.indexes.push(indexData);
		this.indexesByName[name] = indexData;
		if (completionCallback) {
			completionCallback(true);
		}
		return true;
	} else {
		if (completionCallback) {
			completionCallback(false);
		}
		return false;
	}
	
};

/**
 * Opens the engine: this function opens all the indexes at once, makes the initialization if needed,
 *  and makes this engine ready for use. Do not use any function of an engine, except addIndex, before
 *  having opened it.
 *  @param callback function called when the engine is properly opened
 *  @param errorCallback function called if for some reason the engine cannot open some index
 */
fullproof.AbstractEngine.prototype.open = function(callback, errorCallback) {
	var self = this;
	this.storeManager.openIndexes(function(storesArray) {
		self.storeManager.forEach(function(name, index) {
			self.indexesByName[name].index = index;
		});
		callback(self);
	}, errorCallback);
}

/**
 * Inject a text document into all the indexes managed by the engine.
 * @param text some text to be parsed and indexed
 * @param value the primary value (number or string) associated to this object.
 * @param callback the function called when the text injection is done
 */
fullproof.AbstractEngine.prototype.injectDocument = function(text, value, callback) {
	var synchro = fullproof.make_synchro_point(function(data) {
		callback();
	});

	this.forEach(function(name, index, parser) {
		if (name) {
			parser.parse(text, function(word) {
				if (word) {
					index.inject(word, value, synchro); // the line number is the value stored
				} else {
					synchro(false);
				}
			})
		}
	}, false);
};

/**
 * Clears all the indexes managed by this engine. Do not call this function
 * before the engine was open()'ed.
 * @param callback a function called when all the indexes are cleared.
 */
fullproof.AbstractEngine.prototype.clear = function(callback) {
	var synchro = fullproof.make_synchro_point(callback);
	this.forEach(function(name, index, parser) {
		if (name) {
			index.clear(synchro);
		} else {
			synchro(false);
		}
	}, false);
};

/**
 * Inits the current engine with data used by the AbstractEngine object.
 */
fullproof.AbstractEngine.prototype.initAbstractEngine = function() {
	this.storeManager = new fullproof.StoreManager();
	this.indexes = [];
	this.indexesByName =  {};
	return this;
}

fullproof.AbstractEngine.prototype.getIndex = function(name) {
	return this.indexesByName[name].index;
}

fullproof.AbstractEngine.prototype.getIndexUnits = function() {
	return [].concat(this.indexes);
}

/**
 * Iterates over the indexes, in order, and calls the callback function with 3 parameters:
 * the name of the index, the index instance itself, and the analyzer associated to this index.
 * @param callback the callback function(name,index,analyzer){}
 * @return this engine instance 
 */
fullproof.AbstractEngine.prototype.forEach = function(callback) {
	for (var i=0,max=this.indexes.length; i<max; ++i) {
		callback(this.indexes[i].name, this.indexes[i].index, this.indexes[i].analyzer);
	}
	for (var i=1; i<arguments.length; ++i) {
		callback(arguments[i]);
	}
	return this;
}